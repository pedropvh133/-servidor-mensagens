/**
 * NOCTIS MESSENGER - SERVER V20.48 (SECURITY + INTEGRITY)
 * ESTABILIZAÇÃO TOTAL: SHA1 Checksum, Senha Admin Dinâmica e Motor Anti-Sono.
 */

const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const admin = require('firebase-admin');
const B2 = require('backblaze-b2');
const multer = require('multer');
const https = require('https');
const crypto = require('crypto'); // Para cálculo de integridade (SHA1) 🔒
const fs = require('fs');
const path = require('path');
const upload = multer({ dest: '/tmp/' });

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

// --- CONTROLE DE ACESSO ---
let adminPassword = "pedropvh133@gmail.com/admin"; // Senha padrão (backup)
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
        const msgSnap = await db.collection('messages').orderBy('timestamp', 'desc').limit(3000).get();
        messages = msgSnap.docs.map(d => d.data()).reverse();

        const configDoc = await db.collection('system').doc('config').get();
        if (configDoc.exists) {
            latestVersionCode = configDoc.data().versionCode || 1;
            latestApkName = configDoc.data().apkName || "";
            // Carrega a senha admin personalizada se existir 🔑
            if (configDoc.data().adminPassword) {
                adminPassword = configDoc.data().adminPassword;
            }
        }
    } catch (e) { console.error('Erro Backup:', e.message); }
}
loadDataFromBackup();

// --- BROADCAST DE MUDANÇA NO GRUPO ---
function notifyGroupChange(groupId, adminSender, type = "GROUP_STATE_CHANGED") {
    const group = groups.find(g => g.id === groupId);
    if (!group) return;
    group.members.forEach(member => {
        if (!callSignals[member]) callSignals[member] = [];
        callSignals[member].push({
            from: adminSender,
            data: Buffer.from(`${type}:${groupId}`).toString('base64'),
            time: Date.now()
        });
    });
}

// --- FUNÇÃO AUXILIAR: SHA1 HASH 🛡️ ---
function getFileSHA1(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha1');
        const stream = fs.createReadStream(filePath);
        stream.on('data', (data) => hash.update(data));
        stream.on('end', () => resolve(hash.digest('hex')));
        stream.on('error', (err) => reject(err));
    });
}

// --- MIDIA (OTIMIZADA COM STREAMS + SHA1) ---
let b2AuthCache = null;
let b2AuthTime = 0;

async function uploadToB2(dataOrPath, fileName, isFilePath = false) {
    if (!B2_BUCKET_ID) {
        console.error("Erro B2: B2_BUCKET_ID não configurado.");
        return null;
    }
    try {
        // Re-autoriza sempre para garantir que o token não expirou durante o upload de arquivos grandes
        await b2.authorize();
        b2AuthCache = true;
        b2AuthTime = Date.now();

        const uploadUrlResp = await b2.getUploadUrl({ bucketId: B2_BUCKET_ID });

        let uploadParams = {
            uploadUrl: uploadUrlResp.data.uploadUrl,
            uploadAuthToken: uploadUrlResp.data.authorizationToken,
            fileName: fileName
        };

        if (isFilePath) {
            const stats = fs.statSync(dataOrPath);
            const sha1 = await getFileSHA1(dataOrPath);
            uploadParams.data = fs.createReadStream(dataOrPath);
            uploadParams.contentLength = stats.size;
            uploadParams.contentSha1 = sha1;
        } else {
            uploadParams.data = dataOrPath;
        }

        const uploadResp = await b2.uploadFile(uploadParams);
        return `B2_URL:${uploadResp.data.fileName}`;
    } catch (e) {
        // Log detalhado para o administrador no console do Render 🛡️
        const errorDetail = e.response ? JSON.stringify(e.response.data) : e.message;
        console.error("Falha Crítica B2:", errorDetail);
        b2AuthCache = null;
        return null;
    }
}

app.use(cors());
app.use(bodyParser.json({ limit: '100mb' }));

// --- ADMIN ---

app.post('/admin/upload_apk', upload.single('apkFile'), async (req, res) => {
    const { versionCode, password } = req.body;
    if (password !== adminPassword) return res.status(403).send('Senha Incorreta');
    if (!req.file) return res.status(400).send('Arquivo não enviado');

    res.setHeader('Connection', 'keep-alive');

    try {
        const fileName = `update_v${versionCode}_${Date.now()}.apk`;
        const b2Url = await uploadToB2(req.file.path, fileName, true);

        if (b2Url) {
            latestVersionCode = parseInt(versionCode);
            latestApkName = fileName;
            if (db) await db.collection('system').doc('config').set({
                versionCode: latestVersionCode,
                apkName: latestApkName,
                adminPassword: adminPassword
            }, { merge: true });
            if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
            res.json({ status: 'ok', versionCode: latestVersionCode, apkName: latestApkName });
        } else res.status(500).send('Erro no B2 Cloud');
    } catch (e) { res.status(500).send('Erro interno: ' + e.message); }
});

app.post('/admin/update_version', async (req, res) => {
    const { versionCode, apkName, password } = req.body;
    if (password !== adminPassword) return res.status(403).send('Negado');
    latestVersionCode = parseInt(versionCode);
    latestApkName = apkName;
    res.json({ status: 'ok', versionCode: latestVersionCode, apkName: latestApkName });
    if (db) await db.collection('system').doc('config').set({
        versionCode: latestVersionCode,
        apkName: latestApkName
    }, { merge: true });
});

app.post('/admin/change_password', async (req, res) => {
    const { oldPassword, newPassword } = req.body;
    if (oldPassword !== adminPassword) return res.status(403).send('Senha Atual Incorreta');
    if (!newPassword || newPassword.length < 4) return res.status(400).send('Senha muito curta');

    adminPassword = newPassword;
    if (db) await db.collection('system').doc('config').set({ adminPassword: adminPassword }, { merge: true });
    res.json({ status: 'ok' });
});

// --- USUÁRIO ---

app.post('/register', async (req, res) => {
    const { username, password } = req.body;
    if (users.find(u => u.username === username)) return res.status(400).json({ error: 'USUÁRIO_JÁ_EXISTE' });
    const newUser = { username, password, bio: 'Olá!', profilePic: null, lastSeen: Date.now(), blockedUsers: [] };
    users.push(newUser);
    res.status(201).json({ status: 'ok' });
    if (db) await db.collection('users').doc(username).set(newUser);
});

app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    const user = users.find(u => u.username === username);
    if (!user) return res.status(404).json({ error: 'NÃO_ENCONTRADO' });
    if (user.password === password) {
        user.lastSeen = Date.now();
        res.status(200).json({ status: 'ok', ...user });
        if (db) await db.collection('users').doc(username).update({ lastSeen: Date.now() });
    } else res.status(401).json({ error: 'SENHA_INCORRETA' });
});

app.post('/user/update_pic', async (req, res) => {
    const { username, profilePic } = req.body;
    try {
        const b2Url = await uploadToB2(Buffer.from(profilePic, 'base64'), `profile_${username}_${Date.now()}`);
        if (b2Url) {
            let user = users.find(u => u.username === username);
            if (user) {
                user.profilePic = b2Url;
                if (db) await db.collection('users').doc(username).update({ profilePic: b2Url });
            }
            res.json({ status: 'ok', profilePic: b2Url });
        } else res.status(500).send('B2 Error');
    } catch (e) { res.status(500).send(e.message); }
});

app.get('/user/info/:username', (req, res) => {
    const user = users.find(u => u.username === req.params.username);
    if (user) {
        const { password, ...safeUser } = user;
        res.json(safeUser);
    } else res.status(404).json({ error: 'NÃO_ENCONTRADO' });
});

app.get('/conversations/list/:username', (req, res) => {
    const me = req.params.username;

    // Identifica todos os usuários com quem tive troca de mensagens (direta)
    const involvedUsers = new Set();
    messages.forEach(m => {
        if (!m.isGroup) {
            if (m.from === me) involvedUsers.add(m.to);
            if (m.to === me) involvedUsers.add(m.from);
        }
    });

    // Filtra os perfis apenas dos usuários envolvidos
    const list = users.filter(u => involvedUsers.has(u.username)).map(u => {
        const { password, ...safe } = u;
        return safe;
    });

    res.json(list);
});

app.get('/status/:username', (req, res) => {
    const user = users.find(u => u.username === req.params.username);
    if (user) {
        const isOnline = (Date.now() - user.lastSeen) < 60000;
        res.json({ status: isOnline ? "Online" : "Visto por último recentemente" });
    } else res.json({ status: "Offline" });
});

app.post('/user/update_settings', async (req, res) => {
    const { username, currentPassword, newUsername, newPassword, privacyLastSeen, privacyProfilePic, privacyCalls, bio } = req.body;
    const user = users.find(u => u.username === username);
    if (user && user.password === currentPassword) {
        if (newUsername) user.username = newUsername;
        if (newPassword) user.password = newPassword;
        if (privacyLastSeen) user.privacyLastSeen = privacyLastSeen;
        if (privacyProfilePic) user.privacyProfilePic = privacyProfilePic;
        if (privacyCalls) user.privacyCalls = privacyCalls;
        if (bio) user.bio = bio;
        res.status(200).json({ status: 'ok', ...user });
        if (db) await db.collection('users').doc(username).set(user);
    } else res.status(401).send('Erro');
});

app.post('/user/delete_account', async (req, res) => {
    const { username, password } = req.body;
    const idx = users.findIndex(u => u.username === username && u.password === password);
    if (idx !== -1) {
        users.splice(idx, 1);
        res.json({ status: 'ok' });
        if (db) await db.collection('users').doc(username).delete();
    } else res.status(401).send('Erro');
});

app.post('/user/block', async (req, res) => {
    const { username, target } = req.body;
    const user = users.find(u => u.username === username);
    if (user) {
        if (!user.blockedUsers) user.blockedUsers = [];
        if (!user.blockedUsers.includes(target)) user.blockedUsers.push(target);
        res.json({ status: 'ok', list: user.blockedUsers });
        if (db) await db.collection('users').doc(username).update({ blockedUsers: user.blockedUsers });
    } else res.status(404).send('Erro');
});

app.post('/user/unblock', async (req, res) => {
    const { username, target } = req.body;
    const user = users.find(u => u.username === username);
    if (user && user.blockedUsers) {
        user.blockedUsers = user.blockedUsers.filter(b => b !== target);
        res.json({ status: 'ok', list: user.blockedUsers });
        if (db) await db.collection('users').doc(username).update({ blockedUsers: user.blockedUsers });
    } else res.status(404).send('Erro');
});

app.get('/user/blocked_list/:username', (req, res) => {
    const user = users.find(u => u.username === req.params.username);
    res.json(user?.blockedUsers || []);
});

// --- GRUPOS ---

app.post('/create_group', async (req, res) => {
    const { name, creator, description, rules } = req.body;
    const groupId = 'group_' + Date.now();
    const newGroup = { id: groupId, name, creator, members: [creator], admins: [creator], profilePic: null, description: description || "", rules: rules || "" };
    groups.push(newGroup);
    res.status(201).json(newGroup);
    if (db) await db.collection('groups').doc(groupId).set(newGroup);
});

app.get('/groups/:username', (req, res) => res.json(groups.filter(g => g.members.includes(req.params.username))));

app.post(['/group/update_name', '/group/update_settings'], async (req, res) => {
    const { groupId, adminUser, name, description, rules } = req.body;
    const group = groups.find(g => g.id === groupId);
    if (group && group.admins.includes(adminUser)) {
        if (name) group.name = name;
        if (description !== undefined) group.description = description;
        if (rules !== undefined) group.rules = rules;
        res.status(200).json(group);
        notifyGroupChange(groupId, adminUser);
        if (db) await db.collection('groups').doc(groupId).update({ name: group.name, description: group.description, rules: group.rules });
    } else res.status(403).send('Erro');
});

app.post('/group/add_member', async (req, res) => {
    const { groupId, adminUser, newMember } = req.body;
    const group = groups.find(g => g.id === groupId);
    if (group && group.admins.includes(adminUser)) {
        if (!group.members.includes(newMember)) group.members.push(newMember);
        res.status(200).json(group);
        notifyGroupChange(groupId, adminUser);
        if (db) await db.collection('groups').doc(groupId).update({ members: group.members });
    } else res.status(403).send('Erro');
});

app.post('/group/remove_member', async (req, res) => {
    const { groupId, adminUser, targetUser } = req.body;
    const group = groups.find(g => g.id === groupId);
    if (group && group.admins.includes(adminUser)) {
        group.members = group.members.filter(m => m !== targetUser);
        group.admins = group.admins.filter(a => a !== targetUser);
        res.status(200).json(group);

        if (!callSignals[targetUser]) callSignals[targetUser] = [];
        callSignals[targetUser].push({ from: adminUser, data: Buffer.from(`REMOVED_FROM_GROUP:${groupId}`).toString('base64'), time: Date.now() });

        notifyGroupChange(groupId, adminUser);
        if (db) await db.collection('groups').doc(groupId).update({ members: group.members, admins: group.admins });
    } else res.status(403).send('Erro');
});

app.post('/group/promote', async (req, res) => {
    const { groupId, adminUser, targetUser } = req.body;
    const group = groups.find(g => g.id === groupId);
    if (group && group.admins.includes(adminUser)) {
        if (!group.admins.includes(targetUser)) group.admins.push(targetUser);
        res.status(200).json(group);
        notifyGroupChange(groupId, adminUser);
        if (db) await db.collection('groups').doc(groupId).update({ admins: group.admins });
    } else res.status(403).send('Erro');
});

app.post('/group/update_pic', async (req, res) => {
    const { groupId, adminUser, profilePic } = req.body;
    try {
        const group = groups.find(g => g.id === groupId);
        if (group && group.admins.includes(adminUser)) {
            const b2Url = await uploadToB2(Buffer.from(profilePic, 'base64'), `group_${groupId}_${Date.now()}`);
            if (b2Url) {
                group.profilePic = b2Url;
                res.status(200).json(group);
                notifyGroupChange(groupId, adminUser);
                if (db) await db.collection('groups').doc(groupId).update({ profilePic: b2Url });
            } else res.status(500).send('B2 Error');
        } else res.status(403).send('Negado ou não encontrado');
    } catch (e) { res.status(500).send(e.message); }
});

app.post('/group/delete', async (req, res) => {
    const { groupId, adminUser } = req.body;
    const idx = groups.findIndex(g => g.id === groupId && g.admins.includes(adminUser));
    if (idx !== -1) {
        notifyGroupChange(groupId, adminUser, "GROUP_DELETED");
        groups.splice(idx, 1);
        res.json({ status: 'ok' });
        if (db) await db.collection('groups').doc(groupId).delete();
    } else res.status(403).send('Erro');
});

app.get('/group/messages/:groupId', (req, res) => {
    res.json(messages.filter(m => m.isGroup && m.to === req.params.groupId));
});

// --- MENSAGENS ---

app.post('/send_message', async (req, res) => {
    const { username, recipient, content, isAudio, isImage, isVideo, viewOnce, isGroup, unlockTimestamp, replyToId, replyText, replySender } = req.body;
    const target = isGroup ? groups.find(g => g.id === recipient) : users.find(u => u.username === recipient);
    if (!isGroup && target && target.blockedUsers && target.blockedUsers.includes(username)) return res.json({ status: 'ok' });

    let finalContent = content;
    if (isAudio || isImage || isVideo) {
        const b2Url = await uploadToB2(Buffer.from(content, 'base64'), `media_${Date.now()}_${username}`);
        if (b2Url) finalContent = b2Url;
    }

    const msgData = {
        id: Date.now(), from: username, to: recipient, content: finalContent,
        isAudio, isImage, isVideo, viewOnce, isGroup, timestamp: Date.now(),
        read: false, delivered: false, unlockTimestamp: unlockTimestamp || null,
        replyToId: replyToId || null, replyText: replyText || null, replySender: replySender || null
    };

    messages.push(msgData);
    res.status(200).json({ status: 'ok' });
    if (db) await db.collection('messages').doc(msgData.id.toString()).set(msgData);
});

app.post('/delete_message', async (req, res) => {
    const { messageId, username } = req.body;
    const idx = messages.findIndex(m => m.id === messageId && m.from === username);
    if (idx !== -1) {
        messages.splice(idx, 1);
        res.json({ status: 'ok' });
        if (db) await db.collection('messages').doc(messageId.toString()).delete();
    } else res.status(403).send('Erro: Mensagem não encontrada ou sem permissão');
});

app.post('/delete_conversation', async (req, res) => {
    const { username, contact } = req.body;
    try {
        // Filtra quais mensagens devem ser apagadas (RAM)
        const toDelete = messages.filter(m =>
            !m.isGroup &&
            ((m.from === username && m.to === contact) || (m.from === contact && m.to === username))
        );

        // Remove da RAM ⚡
        messages = messages.filter(m => !toDelete.includes(m));

        res.json({ status: 'ok' });

        // Remove do Firestore (Cofre) 🛡️
        if (db && toDelete.length > 0) {
            const batch = db.batch();
            toDelete.forEach(m => {
                batch.delete(db.collection('messages').doc(m.id.toString()));
            });
            await batch.commit();
        }
    } catch (e) {
        console.error("Erro ao apagar conversa:", e.message);
        if (!res.headersSent) res.status(500).send(e.message);
    }
});

app.post('/destroy_view_once', async (req, res) => {
    const { messageId, username } = req.body;
    const idx = messages.findIndex(m => m.id === messageId && (m.from === username || m.to === username));
    if (idx !== -1) {
        messages.splice(idx, 1);
        res.json({ status: 'ok' });
        if (db) await db.collection('messages').doc(messageId.toString()).delete();
    } else res.status(404).send('Off');
});

app.post('/clear_messages', async (req, res) => {
    const { username, password } = req.body;
    const user = users.find(u => u.username === username && u.password === password);
    if (user) {
        messages = messages.filter(m => m.from !== username);
        res.json({ status: 'ok' });
    } else res.status(401).send('Erro');
});

app.get('/conversation/:u1/:u2', async (req, res) => {
    const list = messages.filter(m => !m.isGroup && ((m.from === req.params.u1 && m.to === req.params.u2) || (m.from === req.params.u2 && m.to === req.params.u1)));

    for (let m of messages) {
        if (!m.isGroup && m.from === req.params.u2 && m.to === req.params.u1 && !m.delivered) {
            m.delivered = true;
            if (db) await db.collection('messages').doc(m.id.toString()).update({ delivered: true });
        }
    }
    res.json(list);
});

app.get('/messages/unread/:username', async (req, res) => {
    const me = req.params.username;
    const myGroupsList = groups.filter(g => g.members.includes(me));
    const unread = messages.filter(m => {
        const isToMe = !m.isGroup && m.to === me;
        const isToMyGroup = m.isGroup && myGroupsList.find(g => g.id === m.to) && m.from !== me;
        return (isToMe || isToMyGroup) && !m.read;
    });

    for (let m of unread) {
        if(!m.delivered) {
            m.delivered = true;
            if (db) await db.collection('messages').doc(m.id.toString()).update({ delivered: true });
        }
    }

    const response = unread.map(m => {
        if (m.isGroup) {
            const grp = myGroupsList.find(g => g.id === m.to);
            return { ...m, groupName: grp ? grp.name : "Grupo" };
        }
        return m;
    });
    res.json(response);
});

app.post('/mark_read', async (req, res) => {
    const { username, contact } = req.body;
    for (let m of messages) {
        if (!m.isGroup && m.from === contact && m.to === username && !m.read) {
            m.read = true;
            if (db) await db.collection('messages').doc(m.id.toString()).update({ read: true });
        }
    }
    res.json({ status: 'ok' });
});

app.post('/call/signal', (req, res) => {
    const { to, from, data } = req.body;

    // Lógica de Broadcast para Grupos 🛰️ ✅
    if (to.startsWith('group_')) {
        const group = groups.find(g => g.id === to);
        if (group) {
            group.members.forEach(member => {
                if (member !== from) { // Não envia sinal para o próprio remetente
                    if (!callSignals[member]) callSignals[member] = [];
                    callSignals[member].push({
                        from,
                        data,
                        time: Date.now(),
                        groupName: group.name,
                        groupId: group.id
                    });
                }
            });
            return res.json({ status: 'ok', broadcastedCount: group.members.length - 1 });
        }
    }

    // Sinal 1 pra 1 convencional
    if (!callSignals[to]) callSignals[to] = [];
    callSignals[to].push({ from, data, time: Date.now() });
    res.json({ status: 'ok' });
});

app.get('/call/check/:username', (req, res) => {
    const u = req.params.username;
    const signals = callSignals[u] || [];
    callSignals[u] = []; // Limpa após ler
    res.setHeader('X-Latest-Version', latestVersionCode.toString());
    res.setHeader('X-Apk-Name', latestApkName || "");
    res.json(signals);
});

// --- PÁGINAS ---

app.get('/download', (req, res) => {
    const apkLink = latestApkName ? `/b2file/${latestApkName}` : "#";
    res.send(`
        <!DOCTYPE html>
        <html lang="pt-br">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>NOCTIS - Download Oficial</title>
            <style>
                body { background: #0A0E14; color: white; font-family: 'Segoe UI', sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
                .container { background: rgba(30, 41, 59, 0.6); padding: 50px; border-radius: 30px; border: 1px solid #00D2FF; box-shadow: 0 0 30px rgba(0, 210, 255, 0.15); backdrop-filter: blur(15px); text-align: center; max-width: 400px; width: 90%; }
                .logo { width: 100px; height: 100px; background: linear-gradient(45deg, #00D2FF, #FF00FF); border-radius: 25px; margin: 0 auto 30px; display: flex; align-items: center; justify-content: center; font-size: 50px; box-shadow: 0 0 20px rgba(0, 210, 255, 0.4); }
                h1 { color: #00D2FF; letter-spacing: 3px; margin-bottom: 10px; font-size: 28px; }
                p { color: #94A3B8; font-size: 14px; margin-bottom: 40px; }
                .btn { background: linear-gradient(45deg, #00D2FF, #00A8CC); color: black; text-decoration: none; padding: 18px 30px; border-radius: 12px; font-weight: bold; display: inline-block; transition: 0.3s; text-transform: uppercase; letter-spacing: 1px; box-shadow: 0 4px 15px rgba(0, 210, 255, 0.3); }
                .btn:hover { transform: translateY(-3px); box-shadow: 0 8px 25px rgba(0, 210, 255, 0.5); }
                .version { margin-top: 25px; font-size: 11px; color: #475569; }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="logo">🛰️</div>
                <h1>NOCTIS</h1>
                <p>O mensageiro blindado para quem valoriza a privacidade absoluta.</p>
                <a href="${apkLink}" class="btn">Baixar Versão Atual</a>
                <div class="version">Versão Estável: ${latestVersionCode} | Criptografia GCM-256</div>
            </div>
        </body>
        </html>
    `);
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

app.get('/admin', (req, res) => {
    const totalUsers = users.length;
    const onlineUsers = users.filter(u => (Date.now() - (u.lastSeen || 0)) < 60000).length;

    res.send(`
        <!DOCTYPE html>
        <html lang="pt-br">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>NOCTIS MASTER - Painel de Controle</title>
            <style>
                :root { --accent: #00D2FF; --bg: #0A0E14; --glass: rgba(30, 41, 59, 0.7); }
                body { background: var(--bg); color: white; font-family: 'Segoe UI', system-ui, sans-serif; margin: 0; padding: 20px; display: flex; justify-content: center; }
                .container { width: 100%; max-width: 500px; }
                .card { background: var(--glass); padding: 30px; border-radius: 24px; border: 1px solid rgba(0, 210, 255, 0.2); backdrop-filter: blur(12px); box-shadow: 0 8px 32px rgba(0,0,0,0.4); }
                h1 { color: var(--accent); text-align: center; letter-spacing: 2px; font-size: 24px; margin-bottom: 30px; }

                .stats-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin-bottom: 25px; }
                .stat-box { background: rgba(0,0,0,0.3); padding: 15px; border-radius: 16px; text-align: center; border: 1px solid rgba(255,255,255,0.05); }
                .stat-val { display: block; font-size: 22px; font-weight: bold; color: var(--accent); }
                .stat-label { font-size: 11px; color: #94A3B8; text-transform: uppercase; margin-top: 5px; }

                .status-list { background: rgba(0,0,0,0.2); padding: 15px; border-radius: 16px; margin-bottom: 30px; font-size: 13px; }
                .status-item { display: flex; justify-content: space-between; margin-bottom: 8px; }
                .status-dot { color: #00F260; font-weight: bold; }

                .form-group { margin-bottom: 20px; }
                label { display: block; font-size: 12px; color: #94A3B8; margin-bottom: 8px; margin-left: 5px; }
                input { width: 100%; background: #0F172A; border: 1px solid #334155; color: white; padding: 14px; border-radius: 12px; outline: none; box-sizing: border-box; transition: 0.3s; }
                input:focus { border-color: var(--accent); box-shadow: 0 0 10px rgba(0, 210, 255, 0.1); }

                button { width: 100%; background: linear-gradient(45deg, #00D2FF, #00A8CC); color: black; border: none; padding: 16px; border-radius: 12px; font-weight: bold; cursor: pointer; transition: 0.3s; text-transform: uppercase; letter-spacing: 1px; }
                button:hover { transform: translateY(-2px); box-shadow: 0 5px 15px rgba(0, 210, 255, 0.3); }

                .progress-container { display: none; margin-top: 20px; }
                .progress-bar { width: 100%; background: #1E293B; height: 8px; border-radius: 4px; overflow: hidden; }
                .progress-fill { width: 0%; height: 100%; background: var(--accent); transition: 0.1s; }
                .progress-text { font-size: 10px; color: var(--accent); margin-top: 8px; text-align: right; }

                #msg { text-align: center; margin-top: 20px; font-size: 13px; min-height: 1.2em; }
                hr { border: 0; border-top: 1px solid rgba(255,255,255,0.1); margin: 30px 0; }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="card">
                    <h1>🛰️ MASTER CONTROL</h1>

                    <div class="stats-grid">
                        <div class="stat-box">
                            <span class="stat-val">${totalUsers}</span>
                            <span class="stat-label">Instalações</span>
                        </div>
                        <div class="stat-box">
                            <span class="stat-val">${onlineUsers}</span>
                            <span class="stat-label">Online Agora</span>
                        </div>
                    </div>

                    <div class="status-list">
                        <div class="status-item"><span>🔥 Firebase System</span> <span class="status-dot">${firebaseStatus}</span></div>
                        <div class="status-item"><span>☁️ Cloud B2 Storage</span> <span class="status-dot">${b2Status}</span></div>
                        <div class="status-item"><span>📱 Versão Ativa</span> <span class="status-dot">${latestVersionCode}</span></div>
                    </div>

                    <form id="masterForm">
                        <div class="form-group">
                            <label>Versão Obrigatória (Número)</label>
                            <input name="versionCode" type="number" value="${latestVersionCode}" required>
                        </div>
                        <div class="form-group">
                            <label>Arquivo APK (.apk)</label>
                            <input name="apkFile" type="file" accept=".apk">
                        </div>
                        <div class="form-group">
                            <label>Senha Master de Segurança</label>
                            <input name="password" type="password" placeholder="Digite para autorizar" required>
                        </div>
                        <button type="submit">APLICAR MUDANÇAS 🚀</button>
                    </form>

                    <div class="progress-container" id="progressBox">
                        <div class="progress-bar"><div class="progress-fill" id="progressBar"></div></div>
                        <div class="progress-text" id="percent">0%</div>
                    </div>

                    <p id="msg"></p>

                    <hr>

                    <form id="passForm">
                        <div class="form-group">
                            <label>Alterar Senha de Acesso</label>
                            <input name="oldPassword" type="password" placeholder="Senha Atual" required style="margin-bottom:10px">
                            <input name="newPassword" type="password" placeholder="Nova Senha Master" required>
                        </div>
                        <button type="submit" style="background: #1E293B; color: white; font-size: 11px; padding: 12px;">ATUALIZAR CHAVE MESTRA 🔑</button>
                    </form>
                </div>
            </div>

            <script>
                const msg = document.getElementById('msg');
                const masterForm = document.getElementById('masterForm');

                masterForm.onsubmit = async (e) => {
                    e.preventDefault();
                    const formData = new FormData(masterForm);
                    const progressBox = document.getElementById('progressBox');
                    const progressBar = document.getElementById('progressBar');
                    const percentText = document.getElementById('percent');

                    msg.style.color = "#94A3B8"; msg.innerText = "📡 Sincronizando dados...";

                    const hasFile = formData.get('apkFile').size > 0;

                    if (hasFile) {
                        progressBox.style.display = "block";
                        const xhr = new XMLHttpRequest();
                        xhr.open('POST', '/admin/upload_apk', true);
                        xhr.upload.onprogress = (ev) => {
                            if (ev.lengthComputable) {
                                const p = Math.round((ev.loaded / ev.total) * 100);
                                progressBar.style.width = p + "%";
                                percentText.innerText = (p === 100) ? "Finalizando no B2 Cloud..." : p + "%";
                            }
                        };
                        xhr.onload = () => {
                            if (xhr.status === 200) {
                                msg.style.color = "#00F260"; msg.innerText = "✅ TUDO ATUALIZADO!";
                                setTimeout(() => location.reload(), 1500);
                            } else {
                                msg.style.color = "#FF4B2B"; msg.innerText = "❌ ERRO: " + xhr.responseText;
                                progressBox.style.display = "none";
                            }
                        };
                        xhr.send(formData);
                    } else {
                        // Apenas atualizar versão se não enviou arquivo
                        const data = {
                            versionCode: formData.get('versionCode'),
                            password: formData.get('password')
                        };
                        const resp = await fetch('/admin/update_version', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(data)
                        });
                        if (resp.ok) {
                            msg.style.color = "#00F260"; msg.innerText = "✅ VERSÃO ATUALIZADA!";
                            setTimeout(() => location.reload(), 1500);
                        } else {
                            const txt = await resp.text();
                            msg.style.color = "#FF4B2B"; msg.innerText = "❌ ERRO: " + txt;
                        }
                    }
                };

                document.getElementById('passForm').onsubmit = async (e) => {
                    e.preventDefault();
                    const data = {
                        oldPassword: e.target.oldPassword.value,
                        newPassword: e.target.newPassword.value
                    };
                    msg.style.color = "#94A3B8"; msg.innerText = "🔑 Alterando acesso...";
                    const resp = await fetch('/admin/change_password', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(data)
                    });
                    if (resp.ok) {
                        msg.style.color = "#00F260"; msg.innerText = "✅ SENHA MUDOU! Não esqueça.";
                        e.target.reset();
                    } else {
                        const txt = await resp.text();
                        msg.style.color = "#FF4B2B"; msg.innerText = "❌ ERRO: " + txt;
                    }
                };
            </script>
        </body>
        </html>
    `);
});

app.get('/', (req, res) => {
    res.send(`<h1>🛰️ NOCTIS Hybrid v20.48</h1><p>Status: ONLINE ✅ | Vault: SECURE 🔐</p>`);
});

// --- MOTOR ANTI-SONO (KEEP ALIVE) 🚀 ---
app.get('/ping', (req, res) => res.send('pong'));

setInterval(() => {
    https.get('https://servidor-mensagens.onrender.com/ping', (res) => {
        console.log('Motor Anti-Sono: Ping efetuado ✅');
    }).on('error', (err) => {
        console.error('Motor Anti-Sono: Erro no ping ❌', err.message);
    });
}, 10 * 60 * 1000); // 10 minutos

app.listen(port, () => console.log(`Noctis v20.48 pronto.`));
