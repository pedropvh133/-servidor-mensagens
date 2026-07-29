/**
 * NOCTIS MESSENGER - SERVER V19.4
 * ESTABILIZAÇÃO FINAL: Correção de busca e upload de mídia
 */

const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const admin = require('firebase-admin');
const B2 = require('backblaze-b2');

const app = express();
const port = process.env.PORT || 3000;

// --- FIREBASE ---
const firebaseConfig = process.env.FIREBASE_CONFIG ? JSON.parse(process.env.FIREBASE_CONFIG) : null;
if (firebaseConfig) {
    if (admin.apps.length === 0) {
        admin.initializeApp({ credential: admin.credential.cert(firebaseConfig) });
    }
    console.log('Firebase Inicializado! 🔥');
}
const db = firebaseConfig ? admin.firestore() : null;

// --- BACKBLAZE B2 ---
const b2 = new B2({
    applicationKeyId: process.env.B2_KEY_ID,
    applicationKey: process.env.B2_APP_KEY
});
const B2_BUCKET_ID = process.env.B2_BUCKET_ID;

async function uploadToB2(base64Data, fileName) {
    if (!B2_BUCKET_ID) {
        console.error('ERRO: B2_BUCKET_ID não configurado!');
        return null;
    }
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
        console.log(`Mídia salva no Backblaze: ${fileName} ✅`);
        return `B2_URL:${uploadResp.data.fileName}`;
    } catch (e) {
        console.error('Erro no upload B2:', e.message);
        return null;
    }
}

app.use(cors());
app.use(bodyParser.json({ limit: '100mb' }));

let callSignals = {};

// --- ROTAS ---

app.post('/register', async (req, res) => {
    const { username, password } = req.body;
    if (!db) return res.status(503).send('Servidor em manutenção');
    try {
        const userRef = db.collection('users').doc(username);
        const doc = await userRef.get();
        if (doc.exists) return res.status(400).json({ error: 'USUÁRIO_JÁ_EXISTE' });
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
        if (isAudio || isImage || isVideo) {
            const fileName = `media_${Date.now()}_${username}`;
            const b2Url = await uploadToB2(content, fileName);
            if (b2Url) finalContent = b2Url;
            else return res.status(500).send('Erro no processamento da mídia');
        }
        const msgId = Date.now();
        const msgData = { id: msgId, from: username, to: recipient, content: finalContent, isAudio, isImage, isVideo, viewOnce, isGroup, timestamp: msgId, read: false };
        await db.collection('messages').doc(msgId.toString()).set(msgData);
        await db.collection('users').doc(username).update({ lastSeen: Date.now() });
        res.status(200).json({ status: 'ok' });
    } catch (e) { res.status(500).send(e.message); }
});

app.get('/conversation/:u1/:u2', async (req, res) => {
    try {
        // Busca simplificada para evitar erro de índice no Firestore
        const snap = await db.collection('messages').get();
        const msgs = snap.docs.map(d => d.data())
            .filter(m => !m.isGroup && ((m.from === req.params.u1 && m.to === req.params.u2) || (m.from === req.params.u2 && m.to === req.params.u1)))
            .sort((a, b) => a.timestamp - b.timestamp);
        res.json(msgs);
    } catch (e) { res.status(500).send(e.message); }
});

app.post('/user/delete_account', async (req, res) => {
    const { username, password } = req.body;
    try {
        const userRef = db.collection('users').doc(username);
        const doc = await userRef.get();
        if (doc.exists && doc.data().password === password) {
            await userRef.delete();
            res.status(200).json({ status: 'ok' });
        } else res.status(401).send('Não autorizado');
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
        } else res.status(500).send('Falha no upload');
    } catch (e) { res.status(500).send(e.message); }
});

app.get('/b2file/:filename', async (req, res) => {
    try {
        await b2.authorize();
        const bucketSnap = await b2.getBucket({ bucketId: B2_BUCKET_ID });
        const bucketName = bucketSnap.data.buckets[0].bucketName;
        const downloadResp = await b2.downloadFileByName({
            bucketName: bucketName,
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
        res.json(doc.data());
    } catch (e) { res.status(500).send(e.message); }
});

app.post('/call/signal', async (req, res) => {
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

app.get('/status/:username', async (req, res) => {
    try {
        const doc = await db.collection('users').doc(req.params.username).get();
        if (!doc.exists) return res.json({ status: 'OFFLINE' });
        const online = (Date.now() - doc.data().lastSeen) / 1000 < 45;
        res.json({ status: online ? 'ONLINE' : 'OFFLINE' });
    } catch (e) { res.json({ status: 'OFFLINE' }); }
});

app.get('/', (req, res) => res.send('NOCTIS Galaxy Server v19.4 Ativo! 🌌🚀'));
app.listen(port, () => console.log(`Rodando na porta ${port}`));
