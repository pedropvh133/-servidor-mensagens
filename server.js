/**
 * NOCTIS MESSENGER - SERVER V20.0 (TURBO)
 * ARQUITETURA HÍBRIDA: RAM para Operação + Firebase para Backup
 */

const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const admin = require('firebase-admin');
const B2 = require('backblaze-b2');

const app = express();
const port = process.env.PORT || 3000;

// --- MEMÓRIA RAM (CACHE ATIVO) ---
let users = [];
let messages = [];
let groups = [];
let callSignals = {};

// --- FIREBASE CONFIG ---
const firebaseConfig = process.env.FIREBASE_CONFIG ? JSON.parse(process.env.FIREBASE_CONFIG.replace(/\\n/g, '\n')) : null;
if (firebaseConfig) {
    if (admin.apps.length === 0) admin.initializeApp({ credential: admin.credential.cert(firebaseConfig) });
    console.log('Firebase Backup Ativo! 🔥');
}
const db = firebaseConfig ? admin.firestore() : null;

// --- BACKBLAZE B2 ---
const b2 = new B2({ applicationKeyId: process.env.B2_KEY_ID || '', applicationKey: process.env.B2_APP_KEY || '' });
const B2_BUCKET_ID = process.env.B2_BUCKET_ID;

// --- CARREGAMENTO DE BACKUP (RESSURREIÇÃO) ---
async function loadDataFromBackup() {
    if (!db) return;
    try {
        console.log('Iniciando Ressurreição de Dados... ⏳');

        // Carrega Usuários
        const userSnap = await db.collection('users').get();
        users = userSnap.docs.map(d => d.data());

        // Carrega Grupos
        const groupSnap = await db.collection('groups').get();
        groups = groupSnap.docs.map(d => d.data());

        // Carrega Mensagens (Últimas 5000 para economizar RAM e Leituras)
        const msgSnap = await db.collection('messages')
            .orderBy('timestamp', 'desc')
            .limit(5000)
            .get();
        messages = msgSnap.docs.map(d => d.data()).reverse();

        console.log(`Ressurreição Concluída! ${users.length} usuários e ${messages.length} mensagens carregadas. ✅`);
    } catch (e) { console.error('Erro na Ressurreição:', e.message); }
}

// Inicia o carregamento em segundo plano
loadDataFromBackup();

// --- LOGICA DE MIDIA ---
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

// --- ROTAS TURBO (LEITURA EM RAM) ---

app.post('/register', async (req, res) => {
    const { username, password } = req.body;
    if (users.find(u => u.username === username)) return res.status(400).json({ error: 'USUÁRIO_JÁ_EXISTE' });

    const newUser = { username, password, bio: 'Olá!', profilePic: null, lastSeen: Date.now(), privacyLastSeen: 'Todos', privacyProfilePic: 'Todos', privacyCalls: 'On' };
    users.push(newUser);
    res.status(201).json({ status: 'ok' });

    // Backup em silêncio
    if (db) db.collection('users').doc(username).set(newUser).catch(console.error);
});

app.post('/login', (req, res) => {
    const { username, password } = req.body;
    const user = users.find(u => u.username === username);
    if (!user) return res.status(404).json({ error: 'NÃO_ENCONTRADO' });
    if (user.password === password) {
        user.lastSeen = Date.now();
        res.status(200).json({ status: 'ok', ...user });
        if (db) db.collection('users').doc(username).update({ lastSeen: Date.now() });
    } else res.status(401).json({ error: 'SENHA_INCORRETA' });
});

app.post('/send_message', async (req, res) => {
    const { username, recipient, content, isAudio, isImage, isVideo, viewOnce, isGroup } = req.body;
    let finalContent = content;

    // Upload B2 se for mídia
    if (isAudio || isImage || isVideo) {
        const b2Url = await uploadToB2(content, `media_${Date.now()}_${username}`);
        if (b2Url) finalContent = b2Url;
    }

    const msgData = {
        id: Date.now(), from: username, to: recipient, content: finalContent,
        isAudio, isImage, isVideo, viewOnce, isGroup,
        timestamp: Date.now(), read: false
    };

    messages.push(msgData);
    if (messages.length > 10000) messages.shift(); // Mantém 10k mensagens na RAM

    res.status(200).json({ status: 'ok' });

    // Backup Firestore
    if (db) db.collection('messages').doc(msgData.id.toString()).set(msgData).catch(console.error);
    const user = users.find(u => u.username === username);
    if (user) user.lastSeen = Date.now();
});

app.get('/conversation/:u1/:u2', (req, res) => {
    const list = messages.filter(m => !m.isGroup && ((m.from === req.params.u1 && m.to === req.params.u2) || (m.from === req.params.u2 && m.to === req.params.u1)));
    res.json(list);
});

app.get('/messages/unread/:username', (req, res) => {
    const unread = messages.filter(m => m.to === req.params.username && !m.read);
    res.json(unread);
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

// --- OUTRAS ROTAS ---
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

app.get('/', (req, res) => res.send('NOCTIS Turbo Server v20.0 Ativo! ⚡🌌'));
app.listen(port, () => console.log(`Rodando na porta ${port}`));
