/**
 * NOCTIS MESSENGER - SERVER V20.27 (ULTRA HD & MASTER CONTROL)
 * ESTABILIZAÇÃO: Câmera HD, Qualidade Premium e Deleção Blindada.
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
        if (admin.apps.length === 0) admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
        firebaseStatus = "Conectado! 🔥";
    } catch (err) { firebaseStatus = `Erro no JSON: ${err.message} ❌`; }
}
const db = (admin.apps.length > 0) ? admin.firestore() : null;

// --- BACKBLAZE B2 ---
const b2 = new B2({ applicationKeyId: process.env.B2_KEY_ID || '', applicationKey: process.env.B2_APP_KEY || '' });
const B2_BUCKET_ID = process.env.B2_BUCKET_ID;

async function ensureB2() {
    try {
        await b2.authorize();
        b2Status = "Autorizado! ☁️";
        return true;
    } catch (e) {
        b2Status = "Erro B2 ❌";
        return false;
    }
}
ensureB2();

// --- RESSURREIÇÃO ---
async function loadDataFromBackup() {
    if (!db) return;
    try {
        const userSnap = await db.collection('users').get();
        users = userSnap.docs.map(d => {
            const data = d.data();
            if (!data.blockedUsers) data.blockedUsers = [];
            return data;
        });
        const groupSnap = await db.collection('groups').get();
        groups = groupSnap.docs.map(d => d.data());
        const msgSnap = await db.collection('messages').orderBy('timestamp', 'desc').limit(2000).get();
        messages = msgSnap.docs.map(d => d.data()).reverse();
        backupInfo = `${users.length} usuários e ${groups.length} grupos recuperados. ✅`;
    } catch (e) { backupInfo = "Erro no backup. ⚠️"; }
}
loadDataFromBackup();

// --- MIDIA ---
async function uploadToB2(base64Data, fileName) {
    if (!B2_BUCKET_ID) return null;
    try {
        await ensureB2();
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

// --- ROTAS DE USUÁRIO ---

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

app.post('/user/update_pic', async (req, res) => {
    const { username, profilePic } = req.body;
    const b2Url = await uploadToB2(profilePic, `profile_${username}_${Date.now()}`);
    if (b2Url) {
        let user = users.find(u => u.username === username);
        if (!user && db) {
            const doc = await db.collection('users').doc(username).get();
            if (doc.exists) { user = doc.data(); users.push(user); }
        }
        if (user) {
            user.profilePic = b2Url;
            res.status(200).json({ status: 'ok' });
            if (db) db.collection('users').doc(username).update({ profilePic: b2Url }).catch(() => {});
        } else res.status(404).send('Not found');
    } else res.status(500).send('B2 Error');
});

// --- ROTAS DE GRUPOS ---

app.post('/create_group', async (req, res) => {
    const { name, creator, description, rules } = req.body;
    const groupId = 'group_' + Date.now();
    const newGroup = { id: groupId, name, creator, members: [creator], admins: [creator], profilePic: null, description: description || "", rules: rules || "" };
    groups.push(newGroup);
    res.status(201).json(newGroup);
    if (db) db.collection('groups').doc(groupId).set(newGroup).catch(() => {});
});

app.get('/groups/:username', (req, res) => res.json(groups.filter(g => g.members.includes(req.params.username))));

app.post(['/group/update_name', '/group/update_settings'], (req, res) => {
    const { groupId, adminUser, name, description, rules } = req.body;
    const group = groups.find(g => g.id === groupId);
    if (group && group.admins.includes(adminUser)) {
        if (name) group.name = name;
        if (description !== undefined) group.description = description;
        if (rules !== undefined) group.rules = rules;
        res.status(200).json(group);
        if (db) db.collection('groups').doc(groupId).update({ name: group.name, description: group.description, rules: group.rules }).catch(() => {});
    } else res.status(403).send('Erro');
});

app.post('/group/update_pic', async (req, res) => {
    const { groupId, adminUser, profilePic } = req.body;
    const group = groups.find(g => g.id === groupId);
    if (group && group.admins.includes(adminUser)) {
        const b2Url = await uploadToB2(profilePic, `group_${groupId}_${Date.now()}`);
        if (b2Url) {
            group.profilePic = b2Url;
            res.status(200).json(group);
            if (db) db.collection('groups').doc(groupId).update({ profilePic: b2Url }).catch(() => {});
        } else res.status(500).send('B2 Error');
    } else res.status(403).send('Erro');
});

// --- MENSAGENS E GESTÃO ---

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

app.post('/delete_message', (req, res) => {
    const { messageId, username } = req.body;
    console.log(`Tentativa de deletar msg ${messageId} por ${username}`);

    const index = messages.findIndex(m => m.id == messageId && m.from === username);
    if (index !== -1) {
        messages.splice(index, 1);
        res.json({ status: 'ok' });
        if (db) db.collection('messages').doc(messageId.toString()).delete().catch(() => {});
        console.log(`Mensagem ${messageId} apagada para todos.`);
    } else {
        console.error(`Falha ao deletar: Mensagem não encontrada ou permissão negada.`);
        res.status(403).send('Não autorizado ou Mensagem inexistente');
    }
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

app.get('/group/messages/:groupId', (req, res) => {
    res.json(messages.filter(m => m.isGroup && m.to === req.params.groupId));
});

app.get('/messages/unread/:username', (req, res) => {
    const me = req.params.username;
    const myGroupsList = groups.filter(g => g.members.includes(me));
    const unread = messages.filter(m => {
        const isToMe = !m.isGroup && m.to === me;
        const isToMyGroup = m.isGroup && myGroupsList.find(g => g.id === m.to) && m.from !== me;
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

// --- SINALIZAÇÃO ---

app.post('/call/signal', async (req, res) => {
    const { to, from, data } = req.body;
    if (to.startsWith('group_')) {
        const group = groups.find(g => g.id === to);
        if (group) {
            group.members.forEach(member => {
                if (member !== from) {
                    if (!callSignals[member]) callSignals[member] = [];
                    callSignals[member].push({ from, data, groupName: group.name, time: Date.now() });
                }
            });
            return res.json({ status: 'ok' });
        }
    }
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
    res.send(`<h1>🛰️ NOCTIS Hybrid v20.27</h1><p>Status: Master Control Ativo ✅</p>`);
});

app.listen(port, () => console.log(`Noctis v20.27 pronto.`));
