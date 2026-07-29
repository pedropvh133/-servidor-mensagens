/**
 * NOCTIS MESSENGER - SERVER V19.0
 * FORTALEZA NOCTIS: Firestore + Backblaze B2
 */

const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const admin = require('firebase-admin');
const B2 = require('backblaze-b2');

const app = express();
const port = process.env.PORT || 3000;

// --- CONFIGURAÇÃO FIREBASE ---
// Adicione o conteúdo do seu arquivo JSON de conta de serviço na variável de ambiente FIREBASE_CONFIG
const serviceAccount = process.env.FIREBASE_CONFIG ? JSON.parse(process.env.FIREBASE_CONFIG) : null;

if (serviceAccount) {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
    console.log('Firebase Firestore Inicializado! 🔥');
} else {
    console.error('AVISO: FIREBASE_CONFIG não encontrada. Usando modo temporário.');
}

const db = serviceAccount ? admin.firestore() : null;

// --- CONFIGURAÇÃO BACKBLAZE B2 ---
const b2 = new B2({
    applicationKeyId: process.env.B2_KEY_ID || 'ID_AQUI',
    applicationKey: process.env.B2_APP_KEY || 'CHAVE_AQUI'
});

async function initB2() {
    try {
        await b2.authorize();
        console.log('Backblaze B2 Autorizado! ☁️');
    } catch (e) { console.error('Erro B2:', e.message); }
}
initB2();

app.use(cors());
app.use(bodyParser.json({ limit: '100mb' }));

let callSignals = {};

// --- ROTAS DE USUÁRIO ---

app.post('/register', async (req, res) => {
    const { username, password } = req.body;
    if (!db) return res.status(503).send('Banco offline');

    try {
        const userRef = db.collection('users').doc(username);
        const doc = await userRef.get();
        if (doc.exists) return res.status(400).json({ error: 'USUÁRIO_JÁ_EXISTE' });

        await userRef.set({
            username,
            password,
            bio: 'Olá! Estou usando o Noctis Messenger.',
            profilePic: null,
            lastSeen: Date.now(),
            privacyLastSeen: 'Todos',
            privacyProfilePic: 'Todos',
            privacyCalls: 'On'
        });
        res.status(201).json({ status: 'ok' });
    } catch (e) { res.status(500).send(e.message); }
});

app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    if (!db) return res.status(503).send('Banco offline');

    try {
        const userRef = db.collection('users').doc(username);
        const doc = await userRef.get();
        if (!doc.exists) return res.status(404).json({ error: 'NÃO_ENCONTRADO' });

        const user = doc.data();
        if (user.password === password) {
            await userRef.update({ lastSeen: Date.now() });
            res.status(200).json({
                status: 'ok',
                profilePic: user.profilePic,
                privacyLastSeen: user.privacyLastSeen,
                privacyProfilePic: user.privacyProfilePic,
                privacyCalls: user.privacyCalls || 'On',
                bio: user.bio
            });
        } else res.status(401).json({ error: 'SENHA_INCORRETA' });
    } catch (e) { res.status(500).send(e.message); }
});

app.post('/user/update_settings', async (req, res) => {
    const { username, currentPassword, oldPassword, newUsername, newPassword, privacyLastSeen, privacyProfilePic, privacyCalls, bio } = req.body;
    const pass = currentPassword || oldPassword;
    if (!db) return res.status(503).send('Banco offline');

    try {
        const userRef = db.collection('users').doc(username);
        const doc = await userRef.get();
        if (!doc.exists || doc.data().password !== pass) return res.status(401).json({ error: 'SENHA_INCORRETA' });

        let updateData = { lastSeen: Date.now() };
        if (newPassword) updateData.password = newPassword;
        if (privacyLastSeen) updateData.privacyLastSeen = privacyLastSeen;
        if (privacyProfilePic) updateData.privacyProfilePic = privacyProfilePic;
        if (privacyCalls) updateData.privacyCalls = privacyCalls;
        if (bio !== undefined) updateData.bio = bio;

        if (newUsername && newUsername !== username) {
            const newRef = db.collection('users').doc(newUsername);
            const newDoc = await newRef.get();
            if (newDoc.exists) return res.status(400).json({ error: 'NOME_JÁ_EM_USO' });

            const fullData = { ...doc.data(), ...updateData, username: newUsername };
            await newRef.set(fullData);
            await userRef.delete();
            // Nota: Em um sistema real, seria necessário atualizar referências em mensagens e grupos aqui.
            return res.status(200).json({ status: 'ok', username: newUsername });
        }

        await userRef.update(updateData);
        res.status(200).json({ status: 'ok' });
    } catch (e) { res.status(500).send(e.message); }
});

// --- ROTAS DE MENSAGENS ---

app.post('/send_message', async (req, res) => {
    const { username, recipient, content, isAudio, isImage, isVideo, viewOnce, isGroup } = req.body;
    if (!db) return res.status(503).send('Banco offline');

    try {
        let finalContent = content;

        // Se for mídia pesada, poderíamos fazer o upload para o B2 aqui no futuro.
        // Por enquanto, mantemos o Base64 no Firestore (Limite 1MB por doc) ou links externos.

        const msgData = {
            from: username,
            to: recipient,
            content: finalContent,
            isAudio,
            isImage,
            isVideo,
            viewOnce,
            isGroup,
            timestamp: Date.now(),
            read: false
        };

        await db.collection('messages').add(msgData);
        await db.collection('users').doc(username).update({ lastSeen: Date.now() });
        res.status(200).json({ status: 'ok' });
    } catch (e) { res.status(500).send(e.message); }
});

app.get('/conversation/:u1/:u2', async (req, res) => {
    if (!db) return res.json([]);
    try {
        const snapshot = await db.collection('messages')
            .where('isGroup', '==', false)
            .where('timestamp', '>', Date.now() - (7 * 24 * 60 * 60 * 1000)) // Últimos 7 dias
            .get();

        const msgs = snapshot.docs
            .map(doc => doc.data())
            .filter(m => (m.from === req.params.u1 && m.to === req.params.u2) || (m.from === req.params.u2 && m.to === req.params.u1))
            .sort((a, b) => a.timestamp - b.timestamp);

        res.json(msgs);
    } catch (e) { res.status(500).send(e.message); }
});

app.get('/messages/unread/:username', async (req, res) => {
    if (!db) return res.json([]);
    try {
        const username = req.params.username;
        const snapshot = await db.collection('messages')
            .where('to', '==', username)
            .where('read', '==', false)
            .get();

        // Adicionar lógica de grupos se necessário
        res.json(snapshot.docs.map(doc => doc.data()));
    } catch (e) { res.status(500).send(e.message); }
});

// --- GRUPOS ---

app.post('/create_group', async (req, res) => {
    const { name, creator } = req.body;
    const groupId = 'group_' + Date.now();
    try {
        const newGroup = { id: groupId, name, creator, members: [creator], admins: [creator], profilePic: null };
        await db.collection('groups').doc(groupId).set(newGroup);
        res.status(201).json(newGroup);
    } catch (e) { res.status(500).send(e.message); }
});

app.get('/groups/:username', async (req, res) => {
    if (!db) return res.json([]);
    try {
        const snapshot = await db.collection('groups').where('members', 'array-contains', req.params.username).get();
        res.json(snapshot.docs.map(doc => doc.data()));
    } catch (e) { res.status(500).send(e.message); }
});

// --- CHAMADAS E STATUS ---

app.post('/call/signal', async (req, res) => {
    const { to, from, data } = req.body;
    if (!callSignals[to]) callSignals[to] = [];
    callSignals[to].push({ from, data, time: Date.now() });
    res.status(200).json({ status: 'sent' });
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
        const user = doc.data();
        const online = (Date.now() - user.lastSeen) / 1000 < 40;
        res.json({ status: online ? 'ONLINE' : 'OFFLINE' });
    } catch (e) { res.json({ status: 'ERRO' }); }
});

app.get('/', (req, res) => res.send('NOCTIS Galaxy Server v19.0 Ativo! 🌌'));
app.listen(port, () => console.log(`Servidor na porta ${port}`));
