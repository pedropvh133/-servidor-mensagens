/**
 * NOCTIS MESSENGER - SERVER V20.9 (STABLE)
 * RESILIÊNCIA TOTAL: Sanitização de JSON e Fix de Mídia
 */

const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const admin = require('firebase-admin');
const B2 = require('backblaze-b2');

const app = express();
const port = process.env.PORT || 3000;

let firebaseStatus = "Aguardando chave... ⚪";
let users = [];
let messages = [];
let groups = [];
let callSignals = {};

// --- FIREBASE CONFIG (BULLETPROOF) ---
const rawConfig = process.env.FIREBASE_CONFIG;
if (rawConfig) {
    try {
        let clean = rawConfig.trim();
        // Remove caracteres de controle e garante que quebras de linha sejam \n
        let sanitized = clean.replace(/[\u0000-\u001F\u007F-\u009F]/g, "");

        const serviceAccount = JSON.parse(sanitized);
        if (admin.apps.length === 0) {
            admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
        }
        firebaseStatus = "Conectado com Sucesso! 🔥";
        console.log('Firebase OK ✅');
    } catch (err) {
        firebaseStatus = `Erro no JSON: ${err.message} ❌`;
        console.error(firebaseStatus);
    }
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
        const msgSnap = await db.collection('messages').orderBy('timestamp', 'desc').limit(1000).get();
        messages = msgSnap.docs.map(d => d.data()).reverse();
    } catch (e) { console.error('Aviso: Backup incompleto.'); }
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

app.get('/conversation/:u1/:u2', (req, res) => {
    const list = messages.filter(m => !m.isGroup && ((m.from === req.params.u1 && m.to === req.params.u2) || (m.from === req.params.u2 && m.to === req.params.u1)));
    res.json(list);
});

app.get('/messages/unread/:username', (req, res) => res.json(messages.filter(m => m.to === req.params.username && !m.read)));

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

app.get('/', (req, res) => {
    res.send(`<h1>🛰️ NOCTIS Turbo Server v20.9</h1><p>Firebase Status: ${firebaseStatus}</p>`);
});

app.listen(port, () => console.log(`Noctis Turbo v20.9 no ar.`));
