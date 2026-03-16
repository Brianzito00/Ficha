const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const admin = require('firebase-admin');
const fs = require('fs');

// ==========================================
// 1. CONFIGURAÇÃO DO FIREBASE
// ==========================================
let serviceAccount;

// Verifica se está a rodar no Render (Ficheiro Secreto) ou no seu PC local
if (fs.existsSync('/etc/secrets/firebase-key.json')) {
    console.log("✅ Chave do Firebase encontrada no Render (/etc/secrets).");
    serviceAccount = require('/etc/secrets/firebase-key.json');
} else if (fs.existsSync('./firebase-key.json')) {
    console.log("✅ Chave do Firebase encontrada localmente (./firebase-key.json).");
    serviceAccount = require('./firebase-key.json');
} else {
    console.error("❌ ERRO CRÍTICO: Ficheiro firebase-key.json não encontrado!");
}

// Inicia o Firebase se a chave existir
if (serviceAccount) {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
    console.log("🔥 Firebase conectado com sucesso!");
}
const db = admin.firestore();

// ==========================================
// 2. CONFIGURAÇÃO DO SERVIDOR WEB (EXPRESS)
// ==========================================
const app = express();
const server = http.createServer(app); 
const io = new Server(server);

app.use(express.json({ limit: '10mb' })); 
app.use(express.static(path.join(__dirname, 'public')));

// Redireciona a página principal direto para o Login
app.get('/', (req, res) => {
    res.redirect('/login.html');
});

// ==========================================
// 3. SISTEMA DE CONTAS (API FIREBASE)
// ==========================================

// Registar Novo Jogador
app.post('/api/registar', async (req, res) => {
    const { usuario, senha } = req.body;
    try {
        const userRef = db.collection('usuarios').doc(usuario);
        const doc = await userRef.get();

        if (doc.exists) {
            return res.json({ sucesso: false, erro: 'Este utilizador já existe!' });
        }

        // Guarda o jogador no Firebase (inicia sem ficha)
        await userRef.set({ senha: senha, ficha: null });
        console.log(`👤 Novo utilizador registado: ${usuario}`);
        res.json({ sucesso: true });
        
    } catch (error) {
        console.error("❌ Erro ao registar no Firebase:", error);
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
        
        console.log(`🔓 Utilizador fez login: ${usuario}`);
        res.json({ sucesso: true, ficha: doc.data().ficha });
        
    } catch (error) {
        console.error("❌ Erro ao fazer login no Firebase:", error);
        res.json({ sucesso: false, erro: 'Erro ao contactar o Firebase.' });
    }
});

// Guardar Ficha na Nuvem para Sempre
app.post('/api/guardar_ficha', async (req, res) => {
    const { usuario, fichaData } = req.body;
    try {
        const userRef = db.collection('usuarios').doc(usuario);
        await userRef.update({ ficha: fichaData });
        console.log(`💾 Ficha guardada na nuvem para: ${usuario}`);
        res.json({ sucesso: true });
    } catch (error) {
        console.error("❌ Erro ao guardar ficha no Firebase:", error);
        res.json({ sucesso: false, erro: 'Erro ao guardar a ficha na nuvem.' });
    }
});

// ==========================================
// 4. SISTEMA EM TEMPO REAL (SOCKET.IO)
// ==========================================
const playersData = {}; // Guarda as infos em memória para ser muito rápido

io.on('connection', (socket) => {
    console.log('🟢 Utilizador ligou-se:', socket.id);

    // Quando um jogador altera a vida/sanidade na sua própria ficha
    socket.on('status_change', (dados) => {
        if(dados.codigo) {
            playersData[dados.codigo] = dados;
            io.emit('update_mestre', dados); 
        }
    });

    // Quando o Mestre edita os dados de um jogador (força a atualização na tela do jogador)
    socket.on('mestre_force_sync', (dados) => {
        if(dados.codigo) {
            playersData[dados.codigo] = dados;
            io.emit('update_mestre', dados); 
            io.emit('mestre_force_sync_player', dados); 
        }
    });

    // Quando o Mestre clica no botão "+" ou "-" no Escudo
    socket.on('comando_mestre', (dados) => { 
        io.emit('comando_mestre', dados); 
    });

    // Quando alguém rola um dado
    socket.on('rolagem_feita', (dados) => { 
        io.emit('novo_log', dados); 
    });

    // Quando o Mestre adiciona um jogador ao ecrã (Pede a ficha dele)
    socket.on('request_player', async (codigo) => {
        if(playersData[codigo]) {
            // Se já estiver na memória do servidor (rápido)
            socket.emit('update_mestre', playersData[codigo]);
        } else {
            // Se o servidor reiniciou, vai buscar a última ficha ao Firebase!
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
                    playersData[codigo] = dadosRecuperados; // Guarda na memória
                    socket.emit('update_mestre', dadosRecuperados); // Envia ao mestre
                    console.log(`📦 Ficha recuperada do Firebase para o Mestre: ${codigo}`);
                }
            } catch (error) {
                console.log(`⚠️ Jogador ${codigo} ainda não tem ficha no Firebase ou houve um erro.`);
            }
        }
    });

    socket.on('disconnect', () => { 
        console.log('🔴 Utilizador desligou-se:', socket.id); 
    });
});

// ==========================================
// 5. INICIAR O SERVIDOR
// ==========================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Servidor com FIREBASE a correr na porta ${PORT}!`);
});
