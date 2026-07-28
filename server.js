const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());

// Armazenamento em memória (limpa se o servidor reiniciar)
let users = []; // [{ username, password }]
let messages = [];

// Criar/Verificar usuário com Senha
app.post('/create_user', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).send('Nome e senha obrigatórios');

    const user = users.find(u => u.username === username);

    if (!user) {
        // Novo usuário: define a senha
        users.push({ username, password });
        console.log(`Novo usuário criado: ${username}`);
        return res.status(200).json({ status: 'ok', message: 'Usuário criado' });
    } else {
        // Usuário existe: verifica a senha
        if (user.password === password) {
            console.log(`Login realizado: ${username}`);
            return res.status(200).json({ status: 'ok', message: 'Login bem-sucedido' });
        } else {
            console.log(`Tentativa de login falhou (senha errada): ${username}`);
            return res.status(401).json({ status: 'error', message: 'Senha incorreta' });
        }
    }
});

// Enviar mensagem
app.post('/send_message', (req, res) => {
    const { username, recipient, content } = req.body;
    if (!username || !recipient || !content) return res.status(400).send('Dados incompletos');

    const msg = {
        id: Date.now(),
        from: username,
        to: recipient,
        content,
        time: new Date().toLocaleTimeString()
    };

    messages.push(msg);
    console.log(`Mensagem de ${username} para ${recipient}`);
    res.status(200).json({ status: 'enviada' });
});

// Buscar mensagens recebidas
app.get('/messages/:username', (req, res) => {
    const { username } = req.params;
    const inbox = messages.filter(m => m.to === username);
    res.json(inbox);
});

// Apagar todas as mensagens recebidas (Limpar Caixa)
app.post('/clear_messages', (req, res) => {
    const { username, password } = req.body;
    const user = users.find(u => u.username === username);

    if (user && user.password === password) {
        messages = messages.filter(m => m.to !== username);
        console.log(`Caixa de entrada limpa para: ${username}`);
        res.status(200).json({ status: 'ok', message: 'Caixa limpa' });
    } else {
        res.status(401).json({ status: 'error', message: 'Acesso negado' });
    }
});

app.get('/', (req, res) => res.send('Servidor de Mensagens Seguro Ativo!'));

app.listen(port, () => {
    console.log(`Servidor rodando na porta ${port}`);
});
