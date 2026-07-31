/**
 * NOCTIS MESSENGER - SERVER V20.38 (RAM OPTIMIZATION)
 * ESTABILIZAÇÃO TOTAL: Upload via Disco, Correção de Sinais e Triple Check.
 */

const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const admin = require('firebase-admin');
const B2 = require('backblaze-b2');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const upload = multer({ dest: '/tmp/' }); // Usa o disco temporário do Render em vez da RAM

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

// --- FIREBASE CONFIG (LIMPEZA SEGURA) ---
const rawConfig = process.env.FIREBASE_CONFIG;
if (rawConfig) {
    try {
        let sanitized = rawConfig.trim()
            .replace(/[\u0000-\u001F\u007F-\u009F]/g, "");

        if (sanitized.startsWith('"') && sanitized.endsWith('"')) {
            sanitized = sanitized.substring(1, sanitized.length - 1);
        }

        const serviceAccount = JSON.parse(sanitized);
        if (admin.apps.length === 0) {
            admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
        }
        firebaseStatus = "Conectado! 🔥";
    } catch (err) {
        try {
            const forced = rawConfig.replace(/\n/g, "\\n");
            const serviceAccount = JSON.parse(forced);
            if (admin.apps.length === 0) {
                admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
            }
            firebaseStatus = "Conectado! 🔥";
        } catch (err2) {
            firebaseStatus = `Erro Config: ${err.message} ❌`;
        }
    }
}
const db = (admin.apps.length > 0) ? admin.firestore() : null;

// --- BACKBLAZE B2 ---
const b2 = new B2({ applicationKeyId: process.env.B2_KEY_ID || '', applicationKey: process.env.B2_APP_KEY || '' });
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

        const configDoc = await db.collection('system').doc('config').get();
        if (configDoc.exists) {
            latestVersionCode = configDoc.data().versionCode || 1;
            latestApkName = configDoc.data().apkName || "";
        }
    } catch (e) { console.error('Erro Backup'); }
}
loadDataFromBackup();

// --- BROADCAST DE MUDANÇA NO GRUPO ---
function notifyGroupChange(groupId, adminSender) {
    const group = groups.find(g => g.id === groupId);
    if (!group) return;
    group.members.forEach(member => {
        if (!callSignals[member]) callSignals[member] = [];
        callSignals[member].push({
            from: adminSender,
            data: Buffer.from(`GROUP_STATE_CHANGED:${groupId}`).toString('base64'),
            time: Date.now()
        });
    });
}

// --- MIDIA ---
async function uploadToB2(bufferData, fileName) {
    if (!B2_BUCKET_ID) return null;
    try {
        await b2.authorize();
        const uploadUrlResp = await b2.getUploadUrl({ bucketId: B2_BUCKET_ID });
        const uploadResp = await b2.uploadFile({
            uploadUrl: uploadUrlResp.data.uploadUrl,
            uploadAuthToken: uploadUrlResp.data.authorizationToken,
            fileName: fileName,
            data: bufferData
        });
        return `B2_URL:${uploadResp.data.fileName}`;
    } catch (e) { return null; }
}

app.use(cors());
app.use(bodyParser.json({ limit: '100mb' }));

// --- ADMIN / UPLOAD DIRETO ---

app.post('/admin/upload_apk', upload.single('apkFile'), async (req, res) => {
    const { versionCode, password } = req.body;
    if (password !== "pedropvh133@gmail.com/admin") return res.status(403).send('Senha Incorreta');
    if (!req.file) return res.status(400).send('Arquivo não enviado');

    try {
        const fileName = `update_v${versionCode}_${Date.now()}.apk`;
        // Lê do disco para evitar crash de RAM
        const fileBuffer = fs.readFileSync(req.file.path);
        const b2Url = await uploadToB2(fileBuffer, fileName);

        if (b2Url) {
            latestVersionCode = parseInt(versionCode);
            latestApkName = fileName;

            if (db) db.collection('system').doc('config').set({ versionCode: latestVersionCode, apkName: latestApkName });

            // Limpa o arquivo temporário do disco
            fs.unlinkSync(req.file.path);

            res.json({ status: 'ok', versionCode: latestVersionCode, apkName: latestApkName });
        } else {
            res.status(500).send('Erro no B2 Cloud');
        }
    } catch (e) {
        res.status(500).send('Erro interno: ' + e.message);
    }
});

app.post('/admin/update_version', async (req, res) => {
    const { versionCode, apkName, password } = req.body;
    if (password !== "pedropvh133@gmail.com/admin") return res.status(403).send('Negado');

    latestVersionCode = parseInt(versionCode);
    latestApkName = apkName;
    res.json({ status: 'ok', versionCode: latestVersionCode, apkName: latestApkName });

    if (db) db.collection('system').doc('config').set({ versionCode: latestVersionCode, apkName: latestApkName }).catch(() => {});
});

// --- USUÁRIO ---

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
    const b2Url = await uploadToB2(Buffer.from(profilePic, 'base64'), `profile_${username}_${Date.now()}`);
    if (b2Url) {
        let user = users.find(u => u.username === username);
        if (user) {
            user.profilePic = b2Url;
            res.status(200).json({ status: 'ok' });
            if (db) db.collection('users').doc(username).update({ profilePic: b2Url }).catch(() => {});
        } else res.status(404).send('Not found');
    } else res.status(500).send('B2 Error');
});

// --- SEGURANÇA ---

app.post('/user/block', (req, res) => {
    const { username, target } = req.body;
    const user = users.find(u => u.username === username);
    if (user) {
        if (!user.blockedUsers) user.blockedUsers = [];
        if (!user.blockedUsers.includes(target)) user.blockedUsers.push(target);
        res.json({ status: 'ok', list: user.blockedUsers });
        if (db) db.collection('users').doc(username).update({ blockedUsers: user.blockedUsers });
    } else res.status(404).send('Not found');
});

app.post('/user/unblock', (req, res) => {
    const { username, target } = req.body;
    const user = users.find(u => u.username === username);
    if (user && user.blockedUsers) {
        user.blockedUsers = user.blockedUsers.filter(u => u !== target);
        res.json({ status: 'ok', list: user.blockedUsers });
        if (db) db.collection('users').doc(username).update({ blockedUsers: user.blockedUsers });
    } else res.status(404).send('Not found');
});

app.get('/user/blocked_list/:username', (req, res) => {
    const user = users.find(u => u.username === req.params.username);
    res.json(user ? (user.blockedUsers || []) : []);
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

app.post(['/group/update_name', '/group/update_settings'], (req, res) => {
    const { groupId, adminUser, name, description, rules } = req.body;
    const group = groups.find(g => g.id === groupId);
    if (group && group.admins.includes(adminUser)) {
        if (name) group.name = name;
        if (description !== undefined) group.description = description;
        if (rules !== undefined) group.rules = rules;
        res.status(200).json(group);
        notifyGroupChange(groupId, adminUser);
        if (db) db.collection('groups').doc(groupId).update({ name: group.name, description: group.description, rules: group.rules }).catch(() => {});
    } else res.status(403).send('Erro');
});

app.post('/group/add_member', (req, res) => {
    const { groupId, adminUser, newMember } = req.body;
    const group = groups.find(g => g.id === groupId);
    if (group && group.admins.includes(adminUser)) {
        if (!group.members.includes(newMember)) group.members.push(newMember);
        res.status(200).json(group);
        notifyGroupChange(groupId, adminUser);
        if (db) db.collection('groups').doc(groupId).update({ members: group.members });
    } else res.status(403).send('Erro');
});

app.post('/group/remove_member', (req, res) => {
    const { groupId, adminUser, targetUser } = req.body;
    const group = groups.find(g => g.id === groupId);
    if (group && group.admins.includes(adminUser)) {
        group.members = group.members.filter(m => m !== targetUser);
        group.admins = group.admins.filter(a => a !== targetUser);
        res.status(200).json(group);
        notifyGroupChange(groupId, adminUser);

        // Sinal especial para o removido
        if (!callSignals[targetUser]) callSignals[targetUser] = [];
        callSignals[targetUser].push({ from: adminUser, data: Buffer.from(`REMOVED_FROM_GROUP:${groupId}`).toString('base64'), time: Date.now() });

        if (db) db.collection('groups').doc(groupId).update({ members: group.members, admins: group.admins }).catch(() => {});
    } else res.status(403).send('Erro');
});

app.post('/group/promote', (req, res) => {
    const { groupId, adminUser, targetUser } = req.body;
    const group = groups.find(g => g.id === groupId);
    if (group && group.admins.includes(adminUser)) {
        if (!group.admins.includes(targetUser)) group.admins.push(targetUser);
        res.status(200).json(group);
        notifyGroupChange(groupId, adminUser);
        if (db) db.collection('groups').doc(groupId).update({ admins: group.admins }).catch(() => {});
    } else res.status(403).send('Erro');
});

app.post('/group/update_pic', async (req, res) => {
    const { groupId, adminUser, profilePic } = req.body;
    const group = groups.find(g => g.id === groupId);
    if (group && group.admins.includes(adminUser)) {
        const b2Url = await uploadToB2(Buffer.from(profilePic, 'base64'), `group_${groupId}_${Date.now()}`);
        if (b2Url) {
            group.profilePic = b2Url;
            res.status(200).json(group);
            notifyGroupChange(groupId, adminUser);
            if (db) db.collection('groups').doc(groupId).update({ profilePic: b2Url }).catch(() => {});
        } else res.status(500).send('B2 Error');
    } else res.status(403).send('Erro');
});

app.post('/group/delete', (req, res) => {
    const { groupId, adminUser } = req.body;
    const index = groups.findIndex(g => g.id === groupId);
    if (index !== -1 && groups[index].admins.includes(adminUser)) {
        const groupMembers = [...groups[index].members];
        groups.splice(index, 1);
        res.status(200).json({ status: 'ok' });

        // Avisa todos que o grupo morreu
        groupMembers.forEach(member => {
            if (!callSignals[member]) callSignals[member] = [];
            callSignals[member].push({ from: adminUser, data: Buffer.from(`GROUP_DELETED:${groupId}`).toString('base64'), time: Date.now() });
        });

        if (db) db.collection('groups').doc(groupId).delete().catch(() => {});
    } else res.status(403).send('Erro');
});

// --- MENSAGENS ---

app.post('/send_message', async (req, res) => {
    const { username, recipient, content, isAudio, isImage, isVideo, viewOnce, isGroup } = req.body;
    const target = isGroup ? groups.find(g => g.id === recipient) : users.find(u => u.username === recipient);
    if (!isGroup && target && target.blockedUsers && target.blockedUsers.includes(username)) return res.json({ status: 'ok' });

    let finalContent = content;
    if (isAudio || isImage || isVideo) {
        const b2Url = await uploadToB2(Buffer.from(content, 'base64'), `media_${Date.now()}_${username}`);
        if (b2Url) finalContent = b2Url;
    }
    const msgData = { id: Date.now(), from: username, to: recipient, content: finalContent, isAudio, isImage, isVideo, viewOnce, isGroup, timestamp: Date.now(), read: false, delivered: false };
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
    messages.forEach(m => {
        if (!m.isGroup && m.from === req.params.u2 && m.to === req.params.u1) {
            m.delivered = true;
            if (db) db.collection('messages').doc(m.id.toString()).update({ delivered: true }).catch(() => {});
        }
    });
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
        if(!m.delivered) {
            m.delivered = true;
            if (db) db.collection('messages').doc(m.id.toString()).update({ delivered: true }).catch(() => {});
        }
        if (m.isGroup) {
            const grp = myGroupsList.find(g => g.id === m.to);
            return { ...m, groupName: grp ? grp.name : "Grupo" };
        }
        return m;
    });
    res.json(unread);
});

app.post('/mark_read', (req, res) => {
    const { username, contact } = req.body;
    messages.forEach(m => {
        if (!m.isGroup && m.from === contact && m.to === username) m.read = true;
    });
    res.json({ status: 'ok' });
    if (db) {
        messages.filter(m => !m.isGroup && m.from === contact && m.to === username).forEach(m => {
            db.collection('messages').doc(m.id.toString()).update({ read: true }).catch(() => {});
        });
    }
});

app.post('/delete_message', (req, res) => {
    const { messageId, username } = req.body;
    const index = messages.findIndex(m => m.id == messageId && m.from === username);
    if (index !== -1) {
        messages.splice(index, 1);
        res.json({ status: 'ok' });
        if (db) db.collection('messages').doc(messageId.toString()).delete().catch(() => {});
    } else res.status(403).send('Erro');
});

app.post('/destroy_view_once', (req, res) => {
    const { messageId, username } = req.body;
    const msg = messages.find(m => m.id == messageId && m.to === username && m.viewOnce);
    if (msg) {
        msg.content = "FOTO_AUTODESTRUIDA";
        msg.isImage = false; msg.isVideo = false; msg.isAudio = false;
        res.json({ status: 'ok' });
        if (db) db.collection('messages').doc(messageId.toString()).update({ content: "FOTO_AUTODESTRUIDA", isImage: false, isVideo: false, isAudio: false }).catch(() => {});
    } else res.status(404).send('Off');
});

app.post('/clear_messages', (req, res) => {
    const { username, password } = req.body;
    const user = users.find(u => u.username === username && u.password === password);
    if (user) {
        messages = messages.filter(m => m.from !== username && m.to !== username);
        res.json({ status: 'ok' });
    } else res.status(401).send('Erro');
});

// --- SINALIZAÇÃO & ATUALIZAÇÃO ---

app.get('/call/check/:username', (req, res) => {
    const signals = callSignals[req.params.username] || [];
    callSignals[req.params.username] = [];
    res.set('X-Latest-Version', latestVersionCode.toString());
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
                    callSignals[member].push({ from, data, groupName: group.name, groupId: group.id, time: Date.now() });
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

app.get('/admin', (req, res) => {
    res.send(`
        <body style="background: #0A0E14; color: white; font-family: 'Segoe UI', sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 20px;">
            <div style="background: rgba(30, 41, 59, 0.7); padding: 40px; border-radius: 20px; border: 1px solid #00D2FF; box-shadow: 0 0 20px rgba(0, 210, 255, 0.2); backdrop-filter: blur(10px); width: 100%; max-width: 450px; text-align: center;">
                <h1 style="color: #00D2FF; margin-bottom: 30px; letter-spacing: 2px;">🛰️ MASTER CONTROL</h1>

                <div style="background: rgba(0,0,0,0.3); padding: 15px; border-radius: 10px; margin-bottom: 25px; text-align: left; font-size: 14px;">
                    <p style="margin: 5px 0;">🔥 Firebase: <span style="color: #00F260">${firebaseStatus}</span></p>
                    <p style="margin: 5px 0;">☁️ B2 Cloud: <span style="color: #00F260">${b2Status}</span></p>
                    <p style="margin: 5px 0;">📱 Versão Atual: <span style="color: #FF00FF">${latestVersionCode}</span></p>
                    <p style="margin: 5px 0; font-size: 10px; color: #94A3B8;">APK: ${latestApkName}</p>
                </div>

                <form id="uploadForm" style="display: flex; flex-direction: column; gap: 15px;">
                    <div style="text-align: left;">
                        <label style="font-size: 12px; color: #00D2FF; margin-bottom: 5px; display: block;">NOVA VERSÃO (Número):</label>
                        <input name="versionCode" type="number" placeholder="Ex: 3" style="width: 100%; background: #0F172A; border: 1px solid #334155; color: white; padding: 12px; border-radius: 8px; outline: none; box-sizing: border-box;">
                    </div>

                    <div style="text-align: left;">
                        <label style="font-size: 12px; color: #00D2FF; margin-bottom: 5px; display: block;">ARQUIVO APK:</label>
                        <input name="apkFile" type="file" accept=".apk" style="width: 100%; background: #0F172A; border: 1px solid #334155; color: white; padding: 10px; border-radius: 8px; outline: none; box-sizing: border-box; font-size: 12px;">
                    </div>

                    <div style="text-align: left;">
                        <label style="font-size: 12px; color: #00D2FF; margin-bottom: 5px; display: block;">SENHA MASTER:</label>
                        <input name="password" type="password" placeholder="Sua senha secreta" style="width: 100%; background: #0F172A; border: 1px solid #334155; color: white; padding: 12px; border-radius: 8px; outline: none; box-sizing: border-box;">
                    </div>

                    <button type="submit" style="background: linear-gradient(45deg, #00D2FF, #00A8CC); color: black; border: none; padding: 15px; border-radius: 8px; font-weight: bold; cursor: pointer; transition: 0.3s; margin-top: 10px; text-transform: uppercase;">
                        🚀 SUBIR E LANÇAR ATUALIZAÇÃO
                    </button>
                </form>

                <div id="progressBox" style="display: none; margin-top: 20px;">
                    <div style="width: 100%; background: #1E293B; height: 10px; border-radius: 5px; overflow: hidden;">
                        <div id="progressBar" style="width: 0%; height: 100%; background: #00F260; transition: 0.3s;"></div>
                    </div>
                    <p id="percent" style="font-size: 10px; color: #00F260; margin-top: 5px;">0%</p>
                </div>

                <p id="msg" style="margin-top: 20px; font-size: 12px; color: #94A3B8;"></p>
            </div>

            <script>
                const form = document.getElementById('uploadForm');
                const msg = document.getElementById('msg');
                const progressBox = document.getElementById('progressBox');
                const progressBar = document.getElementById('progressBar');
                const percentText = document.getElementById('percent');

                form.onsubmit = async (e) => {
                    e.preventDefault();
                    const formData = new FormData(form);

                    if(!formData.get('versionCode') || !formData.get('apkFile').name || !formData.get('password')) {
                        msg.style.color = "#FF4B2B";
                        msg.innerText = "⚠️ Preencha todos os campos e selecione o arquivo.";
                        return;
                    }

                    msg.style.color = "#94A3B8";
                    msg.innerText = "📡 Iniciando transferência para a nuvem...";
                    progressBox.style.display = "block";

                    const xhr = new XMLHttpRequest();
                    xhr.open('POST', '/admin/upload_apk', true);

                    xhr.upload.onprogress = (event) => {
                        if (event.lengthComputable) {
                            const percent = Math.round((event.loaded / event.total) * 100);
                            progressBar.style.width = percent + "%";
                            percentText.innerText = percent + "%";
                            if(percent === 100) msg.innerText = "☁️ Processando na nuvem B2... Aguarde.";
                        }
                    };

                    xhr.onload = () => {
                        if (xhr.status === 200) {
                            msg.style.color = "#00F260";
                            msg.innerText = "✅ SUCESSO! APK subido e usuários notificados.";
                            setTimeout(() => location.reload(), 3000);
                        } else {
                            msg.style.color = "#FF4B2B";
                            msg.innerText = "❌ ERRO: " + xhr.responseText;
                            progressBox.style.display = "none";
                        }
                    };

                    xhr.onerror = () => {
                        msg.style.color = "#FF4B2B";
                        msg.innerText = "🚫 Falha na conexão com o servidor.";
                    };

                    xhr.send(formData);
                };
            </script>
        </body>
    `);
});

app.get('/', (req, res) => {
    res.send(`<h1>🛰️ NOCTIS Hybrid v20.38</h1><p>RAM Optimized Upload: Ativo ✅ | Data Integrity: OK ✅</p>`);
});

app.listen(port, () => console.log(`Noctis v20.37 pronto.`));
