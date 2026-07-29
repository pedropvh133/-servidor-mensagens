/**
 * NOCTIS MESSENGER - SERVER V19.1
 * FIREBASE FIRESTORE + BACKBLAZE B2 (HYBRID)
 */

const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const admin = require('firebase-admin');
const B2 = require('backblaze-b2');

const app = express();
const port = process.env.PORT || 3000;

// --- FIREBASE CONFIG ---
const firebaseConfig = process.env.FIREBASE_CONFIG ? JSON.parse(process.env.FIREBASE_CONFIG) : null;
if (firebaseConfig) {
    admin.initializeApp({ credential: admin.credential.cert(firebaseConfig) });
    console.log('Firebase Inicializado! 🔥');
}
const db = firebaseConfig ? admin.firestore() : null;

// --- BACKBLAZE B2 CONFIG ---
const b2 = new B2({
    applicationKeyId: process.env.B2_KEY_ID,
    applicationKey: process.env.B2_APP_KEY
});
const B2_BUCKET_ID = process.env.B2_BUCKET_ID;

async function uploadToB2(base64Data, fileName) {
    try {
        await b2.authorize();
        const uploadUrlResp = await b2.getUploadUrl({ bucketId: B2_BUCKET_ID });
        const buffer = Buffer.from(base64Data, 'base64');

        const uploadResp = await b2.uploadFile({
            uploadUrl: uploadUrlResp.data.uploadUrl,
            uploadAuthToken: uploadUrlResp.data.authorizationToken,
            fileName: fileName,
            data: buffer
        });

        // Retornamos um identificador especial para o App saber que é um link do B2
        return `B2_URL:${uploadResp.data.fileName}`;
    } catch (e) {
        console.error('Erro Upload B2:', e.message);
        return null;
    }
}

app.use(cors());
app.use(bodyParser.json({ limit: '100mb' }));

let callSignals = {};

// --- ROTAS ---

app.post('/register', async (req, res) => {
    const { username, password } = req.body;
    if (!db) return res.status(503).send('DB Offline');
    try {
        const userRef = db.collection('users').doc(username);
        if ((await userRef.get()).exists) return res.status(400).json({ error: 'USUÁRIO_JÁ_EXISTE' });
        await userRef.set({ username, password, bio: 'Olá!', profilePic: null, lastSeen: Date.now(), privacyLastSeen: 'Todos', privacyProfilePic: 'Todos', privacyCalls: 'On' });
        res.status(201).json({ status: 'ok' });
    } catch (e) { res.status(500).send(e.message); }
});

app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const doc = await db.collection('users').doc(username).get();
        if (!doc.exists) return res.status(404).json({ error: 'NÃO_ENCONTRADO' });
        const user = doc.data();
        if (user.password === password) {
            await db.collection('users').doc(username).update({ lastSeen: Date.now() });
            res.status(200).json({ status: 'ok', ...user });
        } else res.status(401).json({ error: 'SENHA_INCORRETA' });
    } catch (e) { res.status(500).send(e.message); }
});

app.post('/send_message', async (req, res) => {
    const { username, recipient, content, isAudio, isImage, isVideo, viewOnce, isGroup } = req.body;
    try {
        let finalContent = content;
        // Se for mídia, sobe pro B2 para não estourar o limite do Firestore (1MB)
        if (isAudio || isImage || isVideo) {
            const fileName = `${Date.now()}_${username}_media`;
            const b2Url = await uploadToB2(content, fileName);
            if (b2Url) finalContent = b2Url;
        }

        const msgData = { from: username, to: recipient, content: finalContent, isAudio, isImage, isVideo, viewOnce, isGroup, timestamp: Date.now(), read: false };
        await db.collection('messages').add(msgData);
        await db.collection('users').doc(username).update({ lastSeen: Date.now() });
        res.status(200).json({ status: 'ok' });
    } catch (e) { res.status(500).send(e.message); }
});

app.get('/conversation/:u1/:u2', async (req, res) => {
    try {
        const snap = await db.collection('messages')
            .where('isGroup', '==', false)
            .where('timestamp', '>', Date.now() - (3 * 24 * 60 * 60 * 1000))
            .get();
        const msgs = snap.docs.map(d => d.data())
            .filter(m => (m.from === req.params.u1 && m.to === req.params.u2) || (m.from === req.params.u2 && m.to === req.params.u1))
            .sort((a, b) => a.timestamp - b.timestamp);
        res.json(msgs);
    } catch (e) { res.status(500).send(e.message); }
});

app.post('/user/update_pic', async (req, res) => {
    const { username, profilePic } = req.body;
    try {
        const fileName = `profile_${username}_${Date.now()}`;
        const b2Url = await uploadToB2(profilePic, fileName);
        if (b2Url) {
            await db.collection('users').doc(username).update({ profilePic: b2Url });
            res.status(200).json({ status: 'ok' });
        } else res.status(500).send('Erro B2');
    } catch (e) { res.status(500).send(e.message); }
});

// Proxy para baixar arquivos do B2 (Oculta as chaves e resolve o problema de URL)
app.get('/b2file/:filename', async (req, res) => {
    try {
        await b2.authorize();
        const downloadResp = await b2.downloadFileByName({
            bucketName: (await b2.getBucket({ bucketId: B2_BUCKET_ID })).data.buckets[0].bucketName,
            fileName: req.params.filename,
            responseType: 'arraybuffer'
        });
        res.send(Buffer.from(downloadResp.data));
    } catch (e) { res.status(404).send('Not found'); }
});

app.get('/user/info/:username', async (req, res) => {
    try {
        const doc = await db.collection('users').doc(req.params.username).get();
        if (!doc.exists) return res.status(404).send('Not found');
        const user = doc.data();
        res.json({ username: user.username, profilePic: user.profilePic, lastSeen: user.lastSeen, bio: user.bio });
    } catch (e) { res.status(500).send(e.message); }
});

app.get('/messages/unread/:username', async (req, res) => {
    try {
        const snap = await db.collection('messages').where('to', '==', req.params.username).where('read', '==', false).get();
        res.json(snap.docs.map(d => d.data()));
    } catch (e) { res.status(500).send(e.message); }
});

app.post('/call/signal', (req, res) => {
    const { to, from, data } = req.body;
    if (!callSignals[to]) callSignals[to] = [];
    callSignals[to].push({ from, data, time: Date.now() });
    res.json({ status: 'sent' });
});

app.get('/call/check/:username', (req, res) => {
    const signals = callSignals[req.params.username] || [];
    callSignals[req.params.username] = [];
    res.json(signals);
});

app.get('/', (req, res) => res.send('NOCTIS Hybrid Server v19.1 Ativo! 🌌🚀'));
app.listen(port, () => console.log(`Servidor na porta ${port}`));
