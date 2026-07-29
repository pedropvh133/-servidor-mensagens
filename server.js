/**
 * NOCTIS MESSENGER - SERVER V20.5 (ULTRA STABLE)
 * CORREÇÃO DE SEGURANÇA E DADOS: RAM Priority com Fallback Seguro
 */

const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const admin = require('firebase-admin');
const B2 = require('backblaze-b2');

const app = express();
const port = process.env.PORT || 3000;

// --- ESTADO GLOBAL (RAM) ---
let users = [];
let messages = [];
let groups = [];
let callSignals = {};
let firebaseStatus = "Aguardando chave... ⚪";

// --- FIREBASE CONFIG (ROBUSTO) ---
const rawConfig = process.env.FIREBASE_CONFIG;
if (rawConfig) {
    try {
        if (rawConfig.trim().startsWith("{")) {
            const serviceAccount = JSON.parse(rawConfig.replace(/\\n/g, '\n'));
            if (admin.apps.length === 0) {
                admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
            }
            firebaseStatus = "Conectado com Sucesso! 🔥";
            console.log('Firebase OK ✅');
        } else {
            firebaseStatus = "ERRO: Você copiou o CÓDIGO de exemplo em vez do arquivo JSON! ❌";
        }
    } catch (err) {
        firebaseStatus = `Erro no formato JSON: ${err.message} ❌`;
    }
}
const db = (admin.apps.length > 0) ? admin.firestore() : null;

// --- BACKBLAZE B2 ---
const b2 = new B2({
    applicationKeyId: process.env.B2_KEY_ID || '',
    applicationKey: process.env.B2_APP_KEY || ''
});
const B2_BUCKET_ID = process.env.B2_BUCKET_ID;

// --- RESSURREIÇÃO ---
async function loadDataFromBackup() {
    if (!db) return;
    try {
        console.log('Iniciando ressurreição... ⏳');
        const userSnap = await db.collection('users').get();
        users = userSnap.docs.map(d => d.data());
        const groupSnap = await db.collection('groups').get();
        groups = groupSnap.docs.map(d => d.data());
        const msgSnap = await db.collection('messages').orderBy('timestamp', 'desc').limit(2000).get();
        messages = msgSnap.docs.map(d => d.data()).reverse();
        console.log(`Dados carregados: ${users.length} users, ${messages.length} msgs.`);
    } catch (e) { console.error('Aviso: Backup inacessível.'); }
}
loadDataFromBackup();

// --- LÓGICA DE MÍDIA ---
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

// --- ROTAS TURBO ---

app.post('/register', async (req, res) => {
    const { username, password } = req.body;
    if (users.find(u => u.username === username)) return res.status(400).json({ error: 'USUÁRIO_JÁ_EXISTE' });

    const newUser = { username, password, bio: 'Olá!', profilePic: null, lastSeen: Date.now(), privacyLastSeen: 'Todos', privacyProfilePic: 'Todos', privacyCalls: 'On' };
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
    let finalContent = content;
    if (isAudio || isImage || isVideo) {
        const b2Url = await uploadToB2(content, `media_${Date.now()}_${username}`);
        if (b2Url) finalContent = b2Url;
    }
    const msgData = { id: Date.now(), from: username, to: recipient, content: finalContent, isAudio, isImage, isVideo, viewOnce, isGroup, timestamp: Date.now(), read: false };
    messages.push(msgData);
    if (messages.length > 5000) messages.shift();
    res.status(200).json({ status: 'ok' });
    if (db) db.collection('messages').doc(msgData.id.toString()).set(msgData).catch(() => {});
});

app.get('/conversation/:u1/:u2', (req, res) => {
    const list = messages.filter(m => !m.isGroup && ((m.from === req.params.u1 && m.to === req.params.u2) || (m.from === req.params.u2 && m.to === req.params.u1)));
    res.json(list);
});

app.get('/messages/unread/:username', (req, res) => {
    res.json(messages.filter(m => m.to === req.params.username && !m.read));
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
        res.send(Buffer.from(downloadResp.data));
    } catch (e) { res.status(404).send('Off'); }
});

app.post('/call/signal', (req, res) => {
    const { to, from, data } = req.body;
    if (!callSignals[to]) callSignals[to] = [];
    callSignals[to].push({ from, data, time: Date.now() });
    res.json({ status: 'ok' });
});

app.get('/call/check/:username', (req, res) => {
    const signals = callSignals[req.params.username] || [];
    callSignals[req.params.username] = [];
    res.json(signals);
});

app.get('/status/:username', (req, res) => {
    const user = users.find(u => u.username === req.params.username);
    if (!user) return res.json({ status: 'OFFLINE' });
    const online = (Date.now() - user.lastSeen) / 1000 < 60;
    res.json({ status: online ? 'ONLINE' : 'OFFLINE' });
});

app.get('/', (req, res) => {
    res.send(`
        <body style="background: #0B0E14; color: white; font-family: sans-serif; padding: 40px; text-align: center;">
            <h1 style="color: #00D2FF;">🛰️ NOCTIS ULTRA STABLE v20.5</h1>
            <div style="background: #1E293B; padding: 20px; border-radius: 15px; border: 1px solid #00D2FF; display: inline-block; min-width: 300px; text-align: left;">
                <p><b>Google Firebase:</b> ${firebaseStatus}</p>
                <p><b>Usuários:</b> ${users.length}</p>
                <p><b>Mensagens:</b> ${messages.length}</p>
            </div>
            <p style="color: #94A3B8; margin-top: 20px;">Seguro. Blindado. Imparável.</p>
        </body>
    `);
});

app.listen(port, () => console.log(`Noctis v20.5 na porta ${port}`));
