/**
 * NOCTIS MESSENGER - SERVER V20.30 (SMART UPDATE)
 * ESTABILIZAÇÃO TOTAL: Sistema de Atualização por Sinalização e Gestão de Mídia.
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
let cachedBucketName = null;

// --- CONTROLE DE VERSÃO ---
let latestVersionCode = 1;
let latestApkName = "";

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
    } catch (err) { firebaseStatus = `Erro JSON: ${err.message} ❌`; }
}
const db = (admin.apps.length > 0) ? admin.firestore() : null;

// --- BACKBLAZE B2 ---
const b2 = new B2({
    applicationKeyId: process.env.B2_KEY_ID || '',
    applicationKey: process.env.B2_APP_KEY || ''
});
const B2_BUCKET_ID = process.env.B2_BUCKET_ID;

async function initB2() {
    if (!process.env.B2_KEY_ID || !B2_BUCKET_ID) return;
    try {
        await b2.authorize();
        const bucketResp = await b2.getBucket({ bucketId: B2_BUCKET_ID });
        if (bucketResp.data.buckets && bucketResp.data.buckets.length > 0) {
            cachedBucketName = bucketResp.data.buckets[0].bucketName;
            b2Status = "Autorizado! ☁️";
        }
    } catch (e) { b2Status = "Erro B2 ❌"; }
}
initB2();

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

        // Recupera versão global do Firebase se existir
        const configDoc = await db.collection('system').doc('config').get();
        if (configDoc.exists) {
            latestVersionCode = configDoc.data().versionCode || 1;
            latestApkName = configDoc.data().apkName || "";
        }
    } catch (e) { console.error('Erro Backup'); }
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

// --- ADMIN / ATUALIZAÇÃO ---

app.post('/admin/update_version', async (req, res) => {
    const { versionCode, apkName, password } = req.body;
    // Senha simples para evitar abusos (pode mudar para uma env se quiser)
    if (password !== "noctis_admin") return res.status(403).send('Negado');

    latestVersionCode = parseInt(versionCode);
    latestApkName = apkName;

    res.json({ status: 'ok', versionCode: latestVersionCode, apkName: latestApkName });

    // Salva no Firebase para persistir após restart do Render
    if (db) {
        db.collection('system').doc('config').set({ versionCode: latestVersionCode, apkName: latestApkName }).catch(() => {});
    }
});

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

// --- SINALIZAÇÃO E ATUALIZAÇÃO ---

app.get('/call/check/:username', (req, res) => {
    const signals = callSignals[req.params.username] || [];
    callSignals[req.params.username] = [];

    // Pega Carona (Piggybacking) da versão no Header
    res.set('X-Latest-Version', latestVersionCode);
    res.set('X-Apk-Name', latestApkName);

    res.json(signals);
});

app.get('/b2file/:filename', async (req, res) => {
    try {
        if (!cachedBucketName) await initB2();
        const downloadResp = await b2.downloadFileByName({
            bucketName: cachedBucketName,
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
    res.send(`<h1>🛰️ NOCTIS Hybrid v20.30</h1><p>Update System: Ativo ✅</p>`);
});

app.listen(port, () => console.log(`Noctis v20.30 pronto.`));
