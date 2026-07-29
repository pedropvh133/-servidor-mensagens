/**
 * NOCTIS MESSENGER - SERVER V20.10 (ELITE DATA DELIVERY)
 * OTIMIZAÇÃO: Entrega de lista de contatos completa com fotos em uma única chamada.
 */

const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const admin = require('firebase-admin');
const B2 = require('backblaze-b2');

const app = express();
const port = process.env.PORT || 3000;

// --- ESTADO GLOBAL ---
let users = [];
let messages = [];
let groups = [];
let callSignals = {};
let firebaseStatus = "Aguardando chave... ⚪";
let backupInfo = "Iniciando...";

// --- FIREBASE CONFIG ---
const rawConfig = process.env.FIREBASE_CONFIG;
if (rawConfig) {
    try {
        let clean = rawConfig.trim();
        let sanitized = clean.replace(/[\u0000-\u001F\u007F-\u009F]/g, "").replace(/\\n/g, '\n');
        const serviceAccount = JSON.parse(sanitized);
        if (admin.apps.length === 0) admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
        firebaseStatus = "Conectado com Sucesso! 🔥";
    } catch (err) { firebaseStatus = `Erro no JSON: ${err.message} ❌`; }
}

const db = (admin.apps.length > 0) ? admin.firestore() : null;
const b2 = new B2({ applicationKeyId: process.env.B2_KEY_ID || '', applicationKey: process.env.B2_APP_KEY || '' });
const B2_BUCKET_ID = process.env.B2_BUCKET_ID;

// --- RESSURREIÇÃO ---
async function loadDataFromBackup() {
    if (!db) return;
    try {
        const userSnap = await db.collection('users').get();
        users = userSnap.docs.map(d => d.data());
        const groupSnap = await db.collection('groups').get();
        groups = groupSnap.docs.map(d => d.data());
        const msgSnap = await db.collection('messages').orderBy('timestamp', 'desc').limit(1000).get();
        messages = msgSnap.docs.map(d => d.data()).reverse();
        backupInfo = `${users.length} usuários recuperados. ✅`;
    } catch (e) { backupInfo = "Erro no backup. ⚠️"; }
}
loadDataFromBackup();

// --- MIDIA ---
async function uploadToB2(base64Data, fileName) {
    if (!B2_BUCKET_ID) return null;
    try {
        await b2.authorize();
        const uploadUrlResp = await b2.getUploadUrl({ bucketId: B2_BUCKET_ID });
        const uploadResp = await b2.uploadFile({
            uploadUrl: uploadUrlResp.data.uploadUrl,
            uploadAuthToken: uploadUrlResp.data.authorizationToken,
            fileName: fileName,
            data: Buffer.from(base64Data, 'base64')
        });
        return `B2_URL:${uploadResp.data.fileName}`;
    } catch (e) { return null; }
}

app.use(cors());
app.use(bodyParser.json({ limit: '100mb' }));

// --- ROTAS ---

app.post('/register', async (req, res) => {
    const { username, password } = req.body;
    if (users.find(u => u.username === username)) return res.status(400).json({ error: 'USUÁRIO_JÁ_EXISTE' });
    const newUser = { username, password, bio: 'Olá!', profilePic: null, lastSeen: Date.now(), blockedUsers: [] };
    users.push(newUser);
    res.status(201).json({ status: 'ok' });
    if (db) db.collection('users').doc(username).set(newUser).catch(() => {});
});

app.post('/login', (req, res) => {
    const { username, password } = req.body;
    const user = users.find(u => u.username === username);
    if (!user) return res.status(404).json({ error: 'NÃO_ENCONTRADO' });
    if (user.password === password) {
        user.lastSeen = Date.now();
        res.status(200).json({ status: 'ok', ...user });
        if (db) db.collection('users').doc(username).update({ lastSeen: Date.now() }).catch(() => {});
    } else res.status(401).json({ error: 'SENHA_INCORRETA' });
});

app.post('/send_message', async (req, res) => {
    const { username, recipient, content, isAudio, isImage, isVideo, viewOnce, isGroup } = req.body;
    const target = users.find(u => u.username === recipient);
    if (target && target.blockedUsers && target.blockedUsers.includes(username)) return res.json({ status: 'ok' });

    let finalContent = content;
    if (isAudio || isImage || isVideo) {
        const b2Url = await uploadToB2(content, `media_${Date.now()}`);
        if (b2Url) finalContent = b2Url;
    }
    const msgData = { id: Date.now(), from: username, to: recipient, content: finalContent, isAudio, isImage, isVideo, viewOnce, isGroup, timestamp: Date.now(), read: false };
    messages.push(msgData);
    res.status(200).json({ status: 'ok' });
    if (db) db.collection('messages').doc(msgData.id.toString()).set(msgData).catch(() => {});
});

// OTIMIZADO: Retorna objetos de usuário completos para a lista inicial
app.get('/conversations/list/:username', (req, res) => {
    const me = req.params.username;
    const involvedUsernames = new Set();
    messages.forEach(m => {
        if (!m.isGroup) {
            if (m.from === me) involvedUsernames.add(m.to);
            if (m.to === me) involvedUsernames.add(m.from);
        }
    });

    const involvedUsers = users
        .filter(u => involvedUsernames.has(u.username))
        .map(u => ({
            username: u.username,
            profilePic: u.profilePic,
            lastSeen: u.lastSeen,
            bio: u.bio
        }));

    res.json(involvedUsers);
});

app.get('/conversation/:u1/:u2', (req, res) => {
    const list = messages.filter(m => !m.isGroup && ((m.from === req.params.u1 && m.to === req.params.u2) || (m.from === req.params.u2 && m.to === req.params.u1)));
    res.json(list);
});

app.post('/user/block', (req, res) => {
    const { username, target } = req.body;
    const user = users.find(u => u.username === username);
    if (user) {
        if (!user.blockedUsers) user.blockedUsers = [];
        if (!user.blockedUsers.includes(target)) user.blockedUsers.push(target);
        res.json({ status: 'ok', list: user.blockedUsers });
        if (db) db.collection('users').doc(username).update({ blockedUsers: user.blockedUsers });
    }
});

app.post('/user/unblock', (req, res) => {
    const { username, target } = req.body;
    const user = users.find(u => u.username === username);
    if (user) {
        user.blockedUsers = (user.blockedUsers || []).filter(u => u !== target);
        res.json({ status: 'ok', list: user.blockedUsers });
        if (db) db.collection('users').doc(username).update({ blockedUsers: user.blockedUsers });
    }
});

app.get('/user/blocked_list/:username', (req, res) => {
    const user = users.find(u => u.username === req.params.username);
    res.json(user ? (user.blockedUsers || []) : []);
});

app.post('/user/update_pic', async (req, res) => {
    const { username, profilePic } = req.body;
    const b2Url = await uploadToB2(profilePic, `profile_${username}_${Date.now()}`);
    if (b2Url) {
        const user = users.find(u => u.username === username);
        if (user) user.profilePic = b2Url;
        res.status(200).json({ status: 'ok' });
        if (db) db.collection('users').doc(username).update({ profilePic: b2Url });
    } else res.status(500).send('Erro B2');
});

app.get('/b2file/:filename', async (req, res) => {
    try {
        await b2.authorize();
        const bucketSnap = await b2.getBucket({ bucketId: B2_BUCKET_ID });
        const downloadResp = await b2.downloadFileByName({
            bucketName: bucketSnap.data.buckets[0].bucketName,
            fileName: req.params.filename,
            responseType: 'arraybuffer'
        });
        res.setHeader('Content-Type', 'application/octet-stream');
        res.send(Buffer.from(downloadResp.data));
    } catch (e) { res.status(404).send('Off'); }
});

app.get('/user/info/:username', (req, res) => {
    const user = users.find(u => u.username === req.params.username);
    if (user) res.json(user);
    else res.status(404).send('Not found');
});

app.get('/status/:username', (req, res) => {
    const user = users.find(u => u.username === req.params.username);
    if (!user) return res.json({ status: 'OFFLINE' });
    const online = (Date.now() - user.lastSeen) / 1000 < 60;
    res.json({ status: online ? 'ONLINE' : 'OFFLINE' });
});

app.get('/', (req, res) => {
    res.send(`
        <body style="background: #0B0E14; color: white; font-family: sans-serif; padding: 40px;">
            <h1>🛰️ NOCTIS Hybrid Server v20.10</h1>
            <div style="background: #1E293B; padding: 20px; border-radius: 10px; border: 1px solid #00D2FF;">
                <p><b>Google Firebase:</b> ${firebaseStatus}</p>
                <p><b>Monitor de Backup:</b> ${backupInfo}</p>
                <p><b>Performance:</b> RAM Priority Ativo ✅</p>
            </div>
        </body>
    `);
});

app.listen(port, () => console.log(`Noctis v20.10 no ar.`));
