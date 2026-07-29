/**
 * NOCTIS MESSENGER - SERVER V20.17 (AUDITORIA E ESTABILIDADE)
 * DIAGNÓSTICO: Logs detalhados para resolver falhas de upload e sincronia.
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
let firebaseStatus = "Aguardando... ⚪";
let b2Status = "Aguardando... ⚪";
let backupInfo = "Iniciando...";

// --- FIREBASE CONFIG ---
const rawConfig = process.env.FIREBASE_CONFIG;
if (rawConfig) {
    try {
        let clean = rawConfig.trim();
        let sanitized = clean.replace(/[\u0000-\u001F\u007F-\u009F]/g, "").replace(/\\n/g, '\n');
        const serviceAccount = JSON.parse(sanitized);
        if (admin.apps.length === 0) {
            admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
        }
        firebaseStatus = "Conectado! 🔥";
        console.log('Firebase: Conexão estabelecida com sucesso.');
    } catch (err) {
        firebaseStatus = `Erro no JSON: ${err.message} ❌`;
        console.error('Firebase Erro:', err.message);
    }
} else {
    console.error('ERRO: Variável FIREBASE_CONFIG não encontrada!');
}

const db = (admin.apps.length > 0) ? admin.firestore() : null;

// --- BACKBLAZE B2 CONFIG ---
const b2 = new B2({
    applicationKeyId: process.env.B2_KEY_ID || '',
    applicationKey: process.env.B2_APP_KEY || ''
});
const B2_BUCKET_ID = process.env.B2_BUCKET_ID;

async function initB2() {
    if (!process.env.B2_KEY_ID || !process.env.B2_APP_KEY || !B2_BUCKET_ID) {
        b2Status = "Faltando chaves no Render! ❌";
        console.error('B2 Erro: Chaves não configuradas.');
        return;
    }
    try {
        await b2.authorize();
        b2Status = "Autorizado com Sucesso! ☁️";
        console.log('B2: Autorização concluída.');
    } catch (e) {
        b2Status = `Erro de Autenticação: ${e.message} ❌`;
        console.error('B2 Erro:', e.message);
    }
}
initB2();

// --- RESSURREIÇÃO ---
async function loadDataFromBackup() {
    if (!db) return;
    try {
        console.log('Iniciando ressurreição... ⏳');
        const userSnap = await db.collection('users').get();
        users = userSnap.docs.map(d => {
            const data = d.data();
            if (!data.blockedUsers) data.blockedUsers = [];
            return data;
        });

        const groupSnap = await db.collection('groups').get();
        groups = groupSnap.docs.map(d => d.data());

        const msgSnap = await db.collection('messages').orderBy('timestamp', 'desc').limit(1000).get();
        messages = msgSnap.docs.map(d => d.data()).reverse();
        backupInfo = `${users.length} usuários e ${groups.length} grupos recuperados. ✅`;
        console.log(`Ressurreição: ${users.length} users, ${groups.length} grupos.`);
    } catch (e) {
        backupInfo = "Erro no backup. ⚠️";
        console.error('Ressurreição Erro:', e.message);
    }
}
loadDataFromBackup();

// --- LOGICA DE MIDIA ---
async function uploadToB2(base64Data, fileName) {
    if (!B2_BUCKET_ID) {
        console.error('B2: Erro - B2_BUCKET_ID não definido.');
        return null;
    }
    try {
        console.log(`Iniciando upload B2: ${fileName}...`);
        await b2.authorize();
        const uploadUrlResp = await b2.getUploadUrl({ bucketId: B2_BUCKET_ID });
        const uploadResp = await b2.uploadFile({
            uploadUrl: uploadUrlResp.data.uploadUrl,
            uploadAuthToken: uploadUrlResp.data.authorizationToken,
            fileName: fileName,
            data: Buffer.from(base64Data, 'base64')
        });
        console.log(`B2 Sucesso: ${fileName} salvo.`);
        return `B2_URL:${uploadResp.data.fileName}`;
    } catch (e) {
        console.error('B2 Upload Falhou:', e.message);
        return null;
    }
}

app.use(cors());
app.use(bodyParser.json({ limit: '100mb' }));

// --- ROTAS ---

app.post('/register', async (req, res) => {
    const { username, password } = req.body;
    console.log(`Tentativa de registro: ${username}`);
    if (users.find(u => u.username === username)) return res.status(400).json({ error: 'USUÁRIO_JÁ_EXISTE' });
    const newUser = { username, password, bio: 'Olá!', profilePic: null, lastSeen: Date.now(), blockedUsers: [] };
    users.push(newUser);
    res.status(201).json({ status: 'ok' });
    if (db) db.collection('users').doc(username).set(newUser).catch(err => console.error('Firestore Error:', err.message));
});

app.post('/login', (req, res) => {
    const { username, password } = req.body;
    console.log(`Tentativa de login: ${username}`);
    const user = users.find(u => u.username === username);
    if (!user) return res.status(404).json({ error: 'NÃO_ENCONTRADO' });
    if (user.password === password) {
        user.lastSeen = Date.now();
        res.status(200).json({ status: 'ok', ...user });
        if (db) db.collection('users').doc(username).update({ lastSeen: Date.now() });
    } else res.status(401).json({ error: 'SENHA_INCORRETA' });
});

app.post('/user/update_pic', async (req, res) => {
    const { username, profilePic } = req.body;
    console.log(`Atualizando foto de: ${username}`);
    const b2Url = await uploadToB2(profilePic, `profile_${username}_${Date.now()}`);
    if (b2Url) {
        const user = users.find(u => u.username === username);
        if (user) {
            user.profilePic = b2Url;
            res.status(200).json({ status: 'ok' });
            if (db) db.collection('users').doc(username).update({ profilePic: b2Url });
        } else res.status(404).send('User not in RAM');
    } else {
        res.status(500).send('B2 Upload Failed');
    }
});

// --- ROTAS DE GRUPOS ---

app.post('/create_group', async (req, res) => {
    const { name, creator } = req.body;
    const groupId = 'group_' + Date.now();
    console.log(`Criando grupo: ${name} por ${creator}`);
    const newGroup = { id: groupId, name, creator, members: [creator], admins: [creator], profilePic: null };
    groups.push(newGroup);
    res.status(201).json(newGroup);
    if (db) db.collection('groups').doc(groupId).set(newGroup).catch(err => console.error('Firestore Group Err:', err.message));
});

app.get('/groups/:username', (req, res) => {
    res.json(groups.filter(g => g.members.includes(req.params.username)));
});

app.get('/group/messages/:groupId', (req, res) => {
    res.json(messages.filter(m => m.isGroup && m.to === req.params.groupId));
});

app.post('/group/add_member', (req, res) => {
    const { groupId, adminUser, newMember } = req.body;
    const group = groups.find(g => g.id === groupId);
    if (group && group.admins.includes(adminUser)) {
        if (!group.members.includes(newMember)) group.members.push(newMember);

        if (!callSignals[newMember]) callSignals[newMember] = [];
        const controlSignal = { from: adminUser, data: Buffer.from(`ADDED_TO_GROUP:${group.name}`).toString('base64'), time: Date.now() };
        callSignals[newMember].push(controlSignal);

        res.status(200).json(group);
        if (db) db.collection('groups').doc(groupId).update({ members: group.members });
    } else res.status(403).send('Não autorizado');
});

// --- MENSAGENS E CHAT ---

app.post('/send_message', async (req, res) => {
    const { username, recipient, content, isAudio, isImage, isVideo, viewOnce, isGroup } = req.body;
    const target = isGroup ? groups.find(g => g.id === recipient) : users.find(u => u.username === recipient);

    if (!isGroup && target && target.blockedUsers && target.blockedUsers.includes(username)) return res.json({ status: 'ok' });

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

app.get('/conversations/list/:username', (req, res) => {
    const me = req.params.username;
    const involved = new Set();
    messages.forEach(m => {
        if (!m.isGroup) {
            if (m.from === me) involved.add(m.to);
            if (m.to === me) involved.add(m.from);
        }
    });
    const result = users.filter(u => involved.has(u.username)).map(u => ({ username: u.username, profilePic: u.profilePic, bio: u.bio, lastSeen: u.lastSeen }));
    res.json(result);
});

app.get('/conversation/:u1/:u2', (req, res) => {
    const list = messages.filter(m => !m.isGroup && ((m.from === req.params.u1 && m.to === req.params.u2) || (m.from === req.params.u2 && m.to === req.params.u1)));
    res.json(list);
});

app.get('/messages/unread/:username', (req, res) => {
    const me = req.params.username;
    const myGroupsList = groups.filter(g => g.members.includes(me));
    const myGroupsIds = myGroupsList.map(g => g.id);
    const unread = messages.filter(m => {
        const isToMe = !m.isGroup && m.to === me;
        const isToMyGroup = m.isGroup && myGroupsIds.includes(m.to) && m.from !== me;
        return (isToMe || isToMyGroup) && !m.read;
    }).map(m => {
        if (m.isGroup) {
            const grp = myGroupsList.find(g => g.id === m.to);
            return { ...m, groupName: grp ? grp.name : "Grupo" };
        }
        return m;
    });
    res.json(unread);
});

// --- SEGURANÇA E OUTROS ---

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
    res.send(`
        <body style="background: #0B0E14; color: white; font-family: sans-serif; padding: 40px;">
            <h1 style="color: #00D2FF;">🛰️ NOCTIS Auditor v20.17</h1>
            <div style="background: #1E293B; padding: 20px; border-radius: 10px; border: 1px solid #00D2FF;">
                <p><b>Google Firebase:</b> ${firebaseStatus}</p>
                <p><b>Backblaze B2:</b> ${b2Status}</p>
                <p><b>Persistência:</b> ${backupInfo}</p>
                <p><b>RAM:</b> ${users.length} usuários | ${groups.length} grupos</p>
            </div>
            <p style="color: #94A3B8; margin-top: 20px;">Use o log do Render para diagnóstico profundo.</p>
        </body>
    `);
});

app.listen(port, () => console.log(`Noctis Auditor pronto.`));
