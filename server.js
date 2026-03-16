const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const admin = require('firebase-admin');

// 1. Ligar ao Firebase usando a sua chave secreta
const serviceAccount = require('./firebase-key.json');
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore(); // Conecta ao Firestore

const app = express();
const server = http.createServer(app); 
const io = new Server(server);

app.use(express.json({ limit: '10mb' })); 
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.redirect('/login.html');
});

// --- SISTEMA DE CONTAS (FIREBASE NA NUVEM) ---

// Registar Novo Jogador
app.post('/api/registar', async (req, res) => {
    const { usuario, senha } = req.body;
    try {
        const userRef = db.collection('usuarios').doc(usuario);
        const doc = await userRef.get();

        if (doc.exists) {
            return res.json({ sucesso: false, erro: 'Este utilizador já existe!' });
        }

        // Guarda o jogador no Firebase
        await userRef.set({ senha: senha, ficha: null });
        res.json({ sucesso: true });
    } catch (error) {
        console.error(error);
        res.json({ sucesso: false, erro: 'Erro ao contactar o Firebase.' });
    }
});

// Fazer Login
app.post('/api/login', async (req, res) => {
    const { usuario, senha } = req.body;
    try {
        const userRef = db.collection('usuarios').doc(usuario);
        const doc = await userRef.get();

        if (!doc.exists || doc.data().senha !== senha) {
            return res.json({ sucesso: false, erro: 'Utilizador ou senha incorretos!' });
        }
        
        res.json({ sucesso: true, ficha: doc.data().ficha });
    } catch (error) {
        res.json({ sucesso: false, erro: 'Erro ao contactar o Firebase.' });
    }
});

// Guardar Ficha para Sempre
app.post('/api/guardar_ficha', async (req, res) => {
    const { usuario, fichaData } = req.body;
    try {
        const userRef = db.collection('usuarios').doc(usuario);
        await userRef.update({ ficha: fichaData });
        res.json({ sucesso: true });
    } catch (error) {
        res.json({ sucesso: false, erro: 'Erro ao guardar a ficha na nuvem.' });
    }
});

// --- SISTEMA EM TEMPO REAL (SOCKET.IO) ---
const playersData = {}; 

io.on('connection', (socket) => {
    console.log('🟢 Utilizador ligou-se:', socket.id);

    socket.on('status_change', (dados) => {
        if(dados.codigo) {
            playersData[dados.codigo] = dados;
            io.emit('update_mestre', dados); 
        }
    });

    socket.on('mestre_force_sync', (dados) => {
        if(dados.codigo) {
            playersData[dados.codigo] = dados;
            io.emit('update_mestre', dados); 
            io.emit('mestre_force_sync_player', dados); 
        }
    });

    socket.on('comando_mestre', (dados) => { io.emit('comando_mestre', dados); });
    socket.on('rolagem_feita', (dados) => { io.emit('novo_log', dados); });

    socket.on('request_player', async (codigo) => {
        if(playersData[codigo]) {
            socket.emit('update_mestre', playersData[codigo]);
        } else {
            // Se o servidor adormeceu e acordou, ele vai buscar a ficha ao Firebase automaticamente!
            try {
                const doc = await db.collection('usuarios').doc(codigo).get();
                if (doc.exists && doc.data().ficha) {
                    const f = doc.data().ficha;
                    const dadosRecuperados = {
                        codigo: codigo,
                        nome: f.info.char_nome,
                        foto: f.info.char_img,
                        nex: f.info.char_nex,
                        defesa: f.defense,
                        vida_atual: f.info.vida_atual, vida_max: f.info.vida_max,
                        sani_atual: f.info.sani_atual, sani_max: f.info.sani_max,
                        status: f.charStatus,
                        fullData: f
                    };
                    playersData[codigo] = dadosRecuperados;
                    socket.emit('update_mestre', dadosRecuperados);
                }
            } catch (error) {
                console.log("Jogador ainda não tem ficha no Firebase.");
            }
        }
    });

    socket.on('disconnect', () => { console.log('🔴 Utilizador desligou-se:', socket.id); });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Servidor com FIREBASE a correr na porta ${PORT}!`);
});
