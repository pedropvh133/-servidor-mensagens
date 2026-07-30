/**
 * NOCTIS MESSENGER - SERVER V20.25 (B2 ROBUSTNESS)
 * ESTABILIZAÇÃO: Correção de Erro 401 e Melhoria de Sincronia de Mídia.
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
        if (admin.apps.length === 0) {
            admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
        }
        firebaseStatus = "Conectado! 🔥";
    } catch (err) { firebaseStatus = `Erro no JSON: ${err.message} ❌`; }
}
const db = (admin.apps.length > 0) ? admin.firestore() : null;

// --- BACKBLAZE B2 CONFIG ---
const b2 = new B2({
    applicationKeyId: process.env.B2_KEY_ID || '',
    applicationKey: process.env.B2_APP_KEY || ''
});
const B2_BUCKET_ID = process.env.B2_BUCKET_ID;

// Função para garantir que o B2 está autorizado antes de cada operação importante
async function ensureB2() {
    try {
        await b2.authorize();
        b2Status = "Autorizado! ☁️";
        return true;
    } catch (e) {
        console.error('Falha na autorização B2:', e.message);
        b2Status = "Erro de Chaves! ❌";
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
        await ensureB2();
        const uploadUrlResp = await b2.getUploadUrl({ bucketId: B2_BUCKET_ID });
        const uploadResp = await b2.uploadFile({
            uploadUrl: uploadUrlResp.data.uploadUrl,
            uploadAuthToken: uploadUrlResp.data.authorizationToken,
            fileName: fileName,
            data: Buffer.from(base64Data, 'base64')
        });
        return `B2_URL:${uploadResp.data.fileName}`;
    } catch (e) {
        console.error('Falha de Upload:', e.message);
        return null;
    }
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

// --- GRUPOS ---

app.post('/create_group', async (req, res) => {
    const { name, creator, description, rules } = req.body;
    const groupId = 'group_' + Date.now();
    const newGroup = { id: groupId, name, creator, members: [creator], admins: [creator], profilePic: null, description: description || "", rules: rules || "" };
    groups.push(newGroup);
    res.status(201).json(newGroup);
    if (db) db.collection('groups').doc(groupId).set(newGroup).catch(() => {});
});

app.get('/groups/:username', (req, res) => res.json(groups.filter(g => g.members.includes(req.params.username))));

app.post('/group/add_member', (req, res) => {
    const { groupId, adminUser, newMember } = req.body;
    const group = groups.find(g => g.id === groupId);
    if (group && group.admins.includes(adminUser)) {
        if (!group.members.includes(newMember)) group.members.push(newMember);
        if (!callSignals[newMember]) callSignals[newMember] = [];
        callSignals[newMember].push({ from: adminUser, data: Buffer.from(`ADDED_TO_GROUP:${group.name}`).toString('base64'), time: Date.now() });
        res.status(200).json(group);
        if (db) db.collection('groups').doc(groupId).update({ members: group.members });
    } else res.status(403).send('Erro');
});

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

// --- MENSAGENS ---

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

// --- SEGURANÇA E SINALIZAÇÃO ---

app.get('/b2file/:filename', async (req, res) => {
    try {
        await ensureB2();
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
    res.send(`
        <body style="background: #0B0E14; color: white; font-family: sans-serif; padding: 40px;">
            <h1>🛰️ NOCTIS Hybrid v20.25</h1>
            <div style="background: #1E293B; padding: 20px; border-radius: 10px; border: 1px solid #00D2FF;">
                <p><b>Google Firebase:</b> ${firebaseStatus}</p>
                <p><b>Backblaze B2:</b> ${b2Status}</p>
                <p><b>Persistência:</b> ${backupInfo}</p>
                <p><b>RAM:</b> ${users.length} usuários | ${groups.length} grupos</p>
            </div>
        </body>
    `);
});

app.listen(port, () => console.log(`Noctis v20.25 no ar.`));
