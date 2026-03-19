const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const admin = require('firebase-admin');

const app = express();
const server = http.createServer(app); 
const io = new Server(server);

app.use(express.json({ limit: '10mb' })); 
app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// 1. INICIALIZAR O FIREBASE
// ==========================================
let db;
try {
    const serviceAccount = require('./firebase-key.json');
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    db = admin.firestore();
    console.log("🔥 Ligado ao Firebase com sucesso!");
} catch (error) {
    console.error("❌ ERRO: Ficheiro 'firebase-key.json' não encontrado!");
    process.exit(1);
}

// ==========================================
// 2. ROTAS DA API
// ==========================================

app.get('/', (req, res) => { res.redirect('/login.html'); });

app.post('/api/registar', async (req, res) => {
    const { usuario, senha } = req.body;
    try {
        const docRef = db.collection('usuarios').doc(usuario);
        const doc = await docRef.get();
        if (doc.exists) return res.json({ sucesso: false, erro: 'Este utilizador já existe!' });
        await docRef.set({ senha: senha });
        res.json({ sucesso: true });
    } catch (error) { res.json({ sucesso: false, erro: 'Erro no banco de dados.' }); }
});

app.post('/api/login', async (req, res) => {
    const { usuario, senha } = req.body;
    try {
        const docRef = db.collection('usuarios').doc(usuario);
        const doc = await docRef.get();
        if (!doc.exists || doc.data().senha !== senha) return res.json({ sucesso: false, erro: 'Utilizador ou senha incorretos!' });
        res.json({ sucesso: true });
    } catch (error) { res.json({ sucesso: false, erro: 'Erro interno.' }); }
});

app.post('/api/carregar_personagem', async (req, res) => {
    const { usuario } = req.body; 
    try {
        const doc = await db.collection('fichas_campanha').doc(usuario).get();
        if (doc.exists) res.json({ sucesso: true, ficha: doc.data().ficha });
        else res.json({ sucesso: true, ficha: null });
    } catch(e) { res.json({ sucesso: false }); }
});

app.post('/api/guardar_ficha', async (req, res) => {
    const { usuario, fichaData } = req.body;
    try {
        await db.collection('fichas_campanha').doc(usuario).set({ ficha: fichaData }, { merge: true }); 
        console.log(`💾 Ficha [${usuario}] salva.`);
        res.json({ sucesso: true });
    } catch (error) { res.json({ sucesso: false }); }
});

app.post('/api/carregar_campanha', async (req, res) => {
    const { campanha } = req.body;
    try {
        const doc = await db.collection('campanhas').doc(campanha).get();
        if (doc.exists) res.json({ sucesso: true, dados: doc.data() });
        else res.json({ sucesso: true, dados: null });
    } catch(e) { res.json({ sucesso: false }); }
});

app.post('/api/salvar_campanha', async (req, res) => {
    const { campanha, dados } = req.body;
    try {
        await db.collection('campanhas').doc(campanha).set(dados, { merge: true });
        res.json({ sucesso: true });
    } catch(e) { res.json({ sucesso: false }); }
});

// NOVA ROTA: Remover os dados de vínculo quando o jogador é expulso ou sai da mesa
app.post('/api/sair_campanha', async (req, res) => {
    const { usuario, campanha } = req.body;
    const idUnico = usuario + '_' + campanha;
    try {
        await db.collection('fichas_campanha').doc(idUnico).delete(); // Apaga a ficha da DB
        delete playersData[idUnico]; // Limpa a cache de memória
        // Avisa o mestre (via socket) que o jogador saiu
        io.to(campanha).emit('comando_mestre', { tipo: 'jogador_saiu', codigo: usuario });
        res.json({ sucesso: true });
    } catch(e) {
        res.json({ sucesso: false });
    }
});


// ==========================================
// 3. COMUNICAÇÃO EM TEMPO REAL (SOCKET)
// ==========================================
const playersData = {}; 

io.on('connection', (socket) => {
    console.log(`🟢 Utilizador ligou-se: ${socket.id}`);

    socket.on('join_campaign', (campanha) => {
        socket.join(campanha);
        socket.campanha = campanha;
    });

    socket.on('novo_item_catalogo_global', (data) => socket.broadcast.to(socket.campanha).emit('sync_item_catalogo_global', data));
    socket.on('remover_item_catalogo_global', (data) => socket.broadcast.to(socket.campanha).emit('item_removido_catalogo_global', data));

    // NOVO: Pedido manual do mestre para limpar o cache da memória RAM do servidor
    socket.on('limpar_cache_jogador', (dados) => {
        if(dados.codigo && socket.campanha) {
            delete playersData[dados.codigo + '_' + socket.campanha];
        }
    });

    socket.on('status_change', (dados) => {
        if(dados.codigo) {
            playersData[dados.codigo + '_' + socket.campanha] = dados;
            socket.broadcast.to(socket.campanha).emit('update_mestre', dados); 
        }
    });

    socket.on('mestre_force_sync', (dados) => {
        if(dados.codigo) {
            playersData[dados.codigo + '_' + socket.campanha] = dados;
            socket.broadcast.to(socket.campanha).emit('update_mestre', dados); 
            socket.broadcast.to(socket.campanha).emit('mestre_force_sync_player', dados); 
        }
    });

    socket.on('comando_mestre', (dados) => socket.broadcast.to(socket.campanha).emit('comando_mestre', dados));
    
    socket.on('rolagem_feita', (dados) => { 
        io.to(socket.campanha).emit('novo_log', dados); 
        io.to(socket.campanha).emit('nova_rolagem', dados); 
    });

    socket.on('request_player', async (codigo) => {
        const idUnico = codigo + '_' + socket.campanha;
        if(playersData[idUnico]) {
            socket.emit('update_mestre', playersData[idUnico]);
        } else {
            try {
                const doc = await db.collection('fichas_campanha').doc(idUnico).get();
                if (doc.exists && doc.data().ficha) {
                    const f = doc.data().ficha;
                    const dadosRecuperados = {
                        codigo: codigo, nome: f.info.char_nome, foto: f.info.char_img, nex: f.info.char_nex, defesa: f.defense,
                        vida_atual: f.info.vida_atual, vida_max: f.info.vida_max, sani_atual: f.info.sani_atual, sani_max: f.info.sani_max,
                        status: f.charStatus, fullData: f
                    };
                    playersData[idUnico] = dadosRecuperados;
                    socket.emit('update_mestre', dadosRecuperados);
                } else {
                    socket.broadcast.to(socket.campanha).emit('mestre_pede_ficha', codigo);
                }
            } catch (e) {}
        }
    });

    socket.on('disconnect', () => console.log(`🔴 Utilizador desligou-se: ${socket.id}`));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => { console.log(`🚀 Servidor a rodar na porta ${PORT}`); });
