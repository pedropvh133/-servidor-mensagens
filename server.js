/**
 * NOCTIS MESSENGER - SERVER V20.2
 * ESTABILIZAÇÃO DEFINITIVA: Debug de Conexão e Robustez JSON
 */

const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const admin = require('firebase-admin');
const B2 = require('backblaze-b2');

const app = express();
const port = process.env.PORT || 3000;

let firebaseStatus = "Não configurado ⚪";
let users = [];
let messages = [];
let groups = [];
let callSignals = {};

// --- FIREBASE CONFIG (SUPER ROBUSTO) ---
const rawConfig = process.env.FIREBASE_CONFIG;
if (rawConfig) {
    try {
        let serviceAccount;
        try {
            serviceAccount = JSON.parse(rawConfig);
        } catch (e) {
            // Se falhar o parse direto, tenta limpar as quebras de linha do Render
            serviceAccount = JSON.parse(rawConfig.replace(/\\n/g, '\n'));
        }

        if (admin.apps.length === 0) {
            admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
        }
        firebaseStatus = "Conectado com Sucesso! 🔥";
        console.log('Firebase OK ✅');
    } catch (err) {
        firebaseStatus = `Erro na Chave JSON: ${err.message} ❌`;
        console.error(firebaseStatus);
    }
}

const db = admin.apps.length > 0 ? admin.firestore() : null;

// --- BACKBLAZE B2 ---
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
        const msgSnap = await db.collection('messages').orderBy('timestamp', 'desc').limit(2000).get();
        messages = msgSnap.docs.map(d => d.data()).reverse();
    } catch (e) { console.error('Erro no load do backup:', e.message); }
}
loadDataFromBackup();

app.use(cors());
app.use(bodyParser.json({ limit: '100mb' }));

// --- ROTAS ---

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
    const msgData = { id: Date.now(), from: username, to: recipient, content, isAudio, isImage, isVideo, viewOnce, isGroup, timestamp: Date.now(), read: false };
    messages.push(msgData);
    if (messages.length > 3000) messages.shift();
    res.status(200).json({ status: 'ok' });
    if (db) db.collection('messages').doc(msgData.id.toString()).set(msgData).catch(() => {});
});

app.get('/conversation/:u1/:u2', (req, res) => {
    const list = messages.filter(m => !m.isGroup && ((m.from === req.params.u1 && m.to === req.params.u2) || (m.from === req.params.u2 && m.to === req.params.u1)));
    res.json(list);
});

app.get('/messages/unread/:username', (req, res) => res.json(messages.filter(m => m.to === req.params.username && !m.read)));

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

// PÁGINA DE STATUS PARA O USUÁRIO CONFERIR
app.get('/', (req, res) => {
    res.send(`
        <h1>NOCTIS Hybrid Server v20.2 Ativo! 🛰️</h1>
        <p><b>Status do Google Firebase:</b> ${firebaseStatus}</p>
        <p><b>Usuários em memória:</b> ${users.length}</p>
        <p><b>Mensagens em memória:</b> ${messages.length}</p>
        <hr>
        <p>Se o Firebase estiver com erro, verifique se você copiou o JSON inteiro para a variável FIREBASE_CONFIG no Render.</p>
    `);
});

app.listen(port, () => console.log(`Noctis rodando na porta ${port}`));
