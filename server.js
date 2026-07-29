/**
 * NOCTIS MESSENGER - SERVER V20.6 (SECURITY UPDATE)
 * GESTÃO DE BLOQUEIO: Bloqueio de usuários e recepção de desconhecidos
 */

const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const admin = require('firebase-admin');
const B2 = require('backblaze-b2');

const app = express();
const port = process.env.PORT || 3000;

// --- ESTADO GLOBAL ---
let users = []; // [{ username, password, bio, profilePic, lastSeen, blockedUsers: [] }]
let messages = [];
let groups = [];
let callSignals = {};
let firebaseStatus = "Aguardando chave... ⚪";

// --- FIREBASE CONFIG ---
try {
    let rawConfig = process.env.FIREBASE_CONFIG;
    if (rawConfig) {
        let sanitized = rawConfig.replace(/[\u0000-\u001F\u007F-\u009F]/g, "").replace(/\\n/g, '\n');
        const serviceAccount = JSON.parse(sanitized);
        if (admin.apps.length === 0) admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
        firebaseStatus = "Conectado com Sucesso! 🔥";
    }
} catch (err) { firebaseStatus = `Erro no JSON: ${err.message} ❌`; }

const db = admin.apps.length > 0 ? admin.firestore() : null;
const b2 = new B2({ applicationKeyId: process.env.B2_KEY_ID || '', applicationKey: process.env.B2_APP_KEY || '' });
const B2_BUCKET_ID = process.env.B2_BUCKET_ID;

// --- RESSURREIÇÃO ---
async function loadDataFromBackup() {
    if (!db) return;
    try {
        const userSnap = await db.collection('users').get();
        users = userSnap.docs.map(d => {
            const data = d.data();
            if (!data.blockedUsers) data.blockedUsers = []; // Inicializa campo novo
            return data;
        });
        const groupSnap = await db.collection('groups').get();
        groups = groupSnap.docs.map(d => d.data());
        const msgSnap = await db.collection('messages').orderBy('timestamp', 'desc').limit(1000).get();
        messages = msgSnap.docs.map(d => d.data()).reverse();
    } catch (e) { console.error('Erro Backup:', e.message); }
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

// --- ROTAS DE SEGURANÇA (BLOQUEIO) ---

app.post('/user/block', (req, res) => {
    const { username, target } = req.body;
    const user = users.find(u => u.username === username);
    if (!user) return res.status(404).send('User not found');
    if (!user.blockedUsers) user.blockedUsers = [];
    if (!user.blockedUsers.includes(target)) user.blockedUsers.push(target);
    res.json({ status: 'blocked', list: user.blockedUsers });
    if (db) db.collection('users').doc(username).update({ blockedUsers: user.blockedUsers });
});

app.post('/user/unblock', (req, res) => {
    const { username, target } = req.body;
    const user = users.find(u => u.username === username);
    if (!user) return res.status(404).send('User not found');
    user.blockedUsers = (user.blockedUsers || []).filter(u => u !== target);
    res.json({ status: 'unblocked', list: user.blockedUsers });
    if (db) db.collection('users').doc(username).update({ blockedUsers: user.blockedUsers });
});

app.get('/user/blocked_list/:username', (req, res) => {
    const user = users.find(u => u.username === req.params.username);
    res.json(user ? (user.blockedUsers || []) : []);
});

// --- ROTAS DE OPERAÇÃO ---

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
        res.status(200).json({ status: 'ok', ...user, blockedUsers: user.blockedUsers || [] });
        if (db) db.collection('users').doc(username).update({ lastSeen: Date.now() });
    } else res.status(401).json({ error: 'SENHA_INCORRETA' });
});

app.post('/send_message', async (req, res) => {
    const { username, recipient, content, isAudio, isImage, isVideo, viewOnce, isGroup } = req.body;

    // FILTRO DE BLOQUEIO
    const target = users.find(u => u.username === recipient);
    if (target && target.blockedUsers && target.blockedUsers.includes(username)) {
        return res.status(200).json({ status: 'ok', info: 'shadow_blocked' });
    }

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

// Retorna todos os usuários que trocaram mensagens com você (para mostrar na lista de chats)
app.get('/conversations/list/:username', (req, res) => {
    const me = req.params.username;
    const involved = new Set();
    messages.forEach(m => {
        if (!m.isGroup) {
            if (m.from === me) involved.add(m.to);
            if (m.to === me) involved.add(m.from);
        }
    });
    res.json(Array.from(involved));
});

app.get('/conversation/:u1/:u2', (req, res) => {
    const list = messages.filter(m => !m.isGroup && ((m.from === req.params.u1 && m.to === req.params.u2) || (m.from === req.params.u2 && m.to === req.params.u1)));
    res.json(list);
});

app.get('/messages/unread/:username', (req, res) => {
    const me = req.params.username;
    const user = users.find(u => u.username === me);
    const blocked = user ? (user.blockedUsers || []) : [];

    const unread = messages.filter(m => m.to === me && !m.read && !blocked.includes(m.from));
    res.json(unread);
});

app.post('/call/signal', (req, res) => {
    const { to, from, data } = req.body;
    // Filtro de Chamada Bloqueada
    const target = users.find(u => u.username === to);
    if (target && target.blockedUsers && target.blockedUsers.includes(from)) return res.json({ status: 'blocked' });

    if (!callSignals[to]) callSignals[to] = [];
    callSignals[to].push({ from, data, time: Date.now() });
    res.json({ status: 'ok' });
});

app.get('/call/check/:username', (req, res) => {
    const signals = callSignals[req.params.username] || [];
    callSignals[req.params.username] = [];
    res.json(signals);
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
        res.send(Buffer.from(downloadResp.data));
    } catch (e) { res.status(404).send('Off'); }
});

app.get('/status/:username', (req, res) => {
    const user = users.find(u => u.username === req.params.username);
    if (!user) return res.json({ status: 'OFFLINE' });
    const online = (Date.now() - user.lastSeen) / 1000 < 60;
    res.json({ status: online ? 'ONLINE' : 'OFFLINE' });
});

app.get('/user/info/:username', (req, res) => {
    const user = users.find(u => u.username === req.params.username);
    if (user) res.json(user);
    else res.status(404).send('Not found');
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

app.get('/', (req, res) => {
    res.send(`<h1>🛰️ NOCTIS Hybrid Server v20.6 (Security)</h1><p>Status Firebase: ${firebaseStatus}</p>`);
});

app.listen(port, () => console.log(`Noctis v20.6 na porta ${port}`));
