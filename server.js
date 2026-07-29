/**
 * NOCTIS MESSENGER - SERVER V20.13 (FULL RESTORATION)
 * ESTABILIZAÇÃO: Restauração de todas as funções (Grupos, Bloqueio, Delete e Unread)
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
let backupInfo = "Iniciando...";

// --- FIREBASE CONFIG ---
const rawConfig = process.env.FIREBASE_CONFIG;
if (rawConfig) {
    try {
        let clean = rawConfig.trim();
        let sanitized = clean.replace(/[\u0000-\u001F\u007F-\u009F]/g, "").replace(/\\n/g, '\n');
        const serviceAccount = JSON.parse(sanitized);
        if (admin.apps.length === 0) admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
        firebaseStatus = "Conectado com Sucesso! 🔥";
    } catch (err) { firebaseStatus = `Erro no JSON: ${err.message} ❌`; }
}

const db = (admin.apps.length > 0) ? admin.firestore() : null;
const b2 = new B2({ applicationKeyId: process.env.B2_KEY_ID || '', applicationKey: process.env.B2_APP_KEY || '' });
const B2_BUCKET_ID = process.env.B2_BUCKET_ID;

// --- RESSURREIÇÃO ---
async function loadDataFromBackup() {
    if (!db) return;
    try {
        console.log('Ressuscitando dados... ⏳');
        const userSnap = await db.collection('users').get();
        users = userSnap.docs.map(d => d.data());

        const groupSnap = await db.collection('groups').get();
        groups = groupSnap.docs.map(d => d.data());

        const msgSnap = await db.collection('messages').orderBy('timestamp', 'desc').limit(1000).get();
        messages = msgSnap.docs.map(d => d.data()).reverse();
        backupInfo = `${users.length} usuários e ${groups.length} grupos recuperados. ✅`;
    } catch (e) { backupInfo = "Erro no backup. ⚠️"; }
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

app.post('/user/update_settings', async (req, res) => {
    const { username, currentPassword, oldPassword, newUsername, newPassword, privacyLastSeen, privacyProfilePic, privacyCalls, bio } = req.body;
    const pass = currentPassword || oldPassword;
    const user = users.find(u => u.username === username);
    if (user && user.password === pass) {
        if (newPassword) user.password = newPassword;
        if (privacyLastSeen) user.privacyLastSeen = privacyLastSeen;
        if (privacyProfilePic) user.privacyProfilePic = privacyProfilePic;
        if (privacyCalls) user.privacyCalls = privacyCalls;
        if (bio !== undefined) user.bio = bio;
        res.status(200).json({ status: 'ok' });
        if (db) db.collection('users').doc(username).update(user).catch(() => {});
    } else res.status(401).send('Erro');
});

app.post('/user/delete_account', async (req, res) => {
    const { username, password } = req.body;
    const index = users.findIndex(u => u.username === username && u.password === password);
    if (index !== -1) {
        users.splice(index, 1);
        res.status(200).json({ status: 'ok' });
        if (db) {
            db.collection('users').doc(username).delete().catch(() => {});
            // Opcional: Apagar mensagens do usuário
        }
    } else res.status(401).send('Não autorizado');
});

// --- ROTAS DE GRUPOS ---

app.post('/create_group', async (req, res) => {
    const { name, creator } = req.body;
    const groupId = 'group_' + Date.now();
    const newGroup = { id: groupId, name, creator, members: [creator], admins: [creator], profilePic: null };
    groups.push(newGroup);
    res.status(201).json(newGroup);
    if (db) db.collection('groups').doc(groupId).set(newGroup).catch(() => {});
});

app.get('/groups/:username', (req, res) => {
    res.json(groups.filter(g => g.members.includes(req.params.username)));
});

app.post('/group/add_member', (req, res) => {
    const { groupId, adminUser, newMember } = req.body;
    const group = groups.find(g => g.id === groupId);
    if (group && group.admins.includes(adminUser)) {
        if (!group.members.includes(newMember)) group.members.push(newMember);
        res.status(200).json(group);
        if (db) db.collection('groups').doc(groupId).update({ members: group.members });
    } else res.status(403).send('Não autorizado');
});

app.post('/group/update_pic', async (req, res) => {
    const { groupId, adminUser, profilePic } = req.body;
    const group = groups.find(g => g.id === groupId);
    if (group && group.admins.includes(adminUser)) {
        const b2Url = await uploadToB2(profilePic, `group_${groupId}_${Date.now()}`);
        if (b2Url) {
            group.profilePic = b2Url;
            res.status(200).json(group);
            if (db) db.collection('groups').doc(groupId).update({ profilePic: b2Url });
        } else res.status(500).send('Erro B2');
    } else res.status(403).send('Não autorizado');
});

app.post('/group/delete', (req, res) => {
    const { groupId, adminUser } = req.body;
    const index = groups.findIndex(g => g.id === groupId);
    if (index !== -1 && groups[index].admins.includes(adminUser)) {
        groups.splice(index, 1);
        res.status(200).json({ status: 'ok' });
        if (db) db.collection('groups').doc(groupId).delete().catch(() => {});
    } else res.status(403).send('Não autorizado');
});

// --- MENSAGENS E CHAT ---

app.post('/send_message', async (req, res) => {
    const { username, recipient, content, isAudio, isImage, isVideo, viewOnce, isGroup } = req.body;
    const target = users.find(u => u.username === recipient);
    if (target && target.blockedUsers && target.blockedUsers.includes(username)) return res.json({ status: 'ok' });

    let finalContent = content;
    if (isAudio || isImage || isVideo) {
        const b2Url = await uploadToB2(content, `media_${Date.now()}_${username}`);
        if (b2Url) finalContent = b2Url;
    }
    const msgData = { id: Date.now(), from: username, to: recipient, content: finalContent, isAudio, isImage, isVideo, viewOnce, isGroup, timestamp: Date.now(), read: false };
    messages.push(msgData);
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
    res.json(messages.filter(m => m.to === req.params.username && !m.read));
});

// --- SEGURANÇA E BLOQUEIO ---

app.post('/user/block', (req, res) => {
    const { username, target } = req.body;
    const user = users.find(u => u.username === username);
    if (user) {
        if (!user.blockedUsers) user.blockedUsers = [];
        if (!user.blockedUsers.includes(target)) user.blockedUsers.push(target);
        res.json({ status: 'ok', list: user.blockedUsers });
        if (db) db.collection('users').doc(username).update({ blockedUsers: user.blockedUsers });
    }
});

app.post('/user/unblock', (req, res) => {
    const { username, target } = req.body;
    const user = users.find(u => u.username === username);
    if (user) {
        user.blockedUsers = (user.blockedUsers || []).filter(u => u !== target);
        res.json({ status: 'ok', list: user.blockedUsers });
        if (db) db.collection('users').doc(username).update({ blockedUsers: user.blockedUsers });
    }
});

app.get('/user/blocked_list/:username', (req, res) => {
    const user = users.find(u => u.username === req.params.username);
    res.json(user ? (user.blockedUsers || []) : []);
});

// --- OUTRAS ROTAS ---

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
        res.setHeader('Content-Type', 'application/octet-stream');
        res.send(Buffer.from(downloadResp.data));
    } catch (e) { res.status(404).send('Off'); }
});

app.post('/user/update_pic', async (req, res) => {
    const { username, profilePic } = req.body;
    const b2Url = await uploadToB2(profilePic, `profile_${username}_${Date.now()}`);
    if (b2Url) {
        const user = users.find(u => u.username === username);
        if (user) {
            user.profilePic = b2Url;
            res.status(200).json({ status: 'ok' });
            if (db) db.collection('users').doc(username).update({ profilePic: b2Url });
        }
    } else res.status(500).send('Erro B2');
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

app.get('/user/info/:username', (req, res) => {
    const user = users.find(u => u.username === req.params.username);
    if (user) res.json(user);
    else res.status(404).send('Not found');
});

app.get('/', (req, res) => {
    res.send(`
        <body style="background: #0B0E14; color: white; font-family: sans-serif; padding: 40px;">
            <h1>🛰️ NOCTIS Hybrid Server v20.13</h1>
            <div style="background: #1E293B; padding: 20px; border-radius: 10px; border: 1px solid #00D2FF;">
                <p><b>Google Firebase:</b> ${firebaseStatus}</p>
                <p><b>Persistência:</b> ${backupInfo}</p>
                <p><b>RAM:</b> ${users.length} usuários | ${groups.length} grupos</p>
            </div>
        </body>
    `);
});

app.listen(port, () => console.log(`Noctis v20.13 pronto.`));
