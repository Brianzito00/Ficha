const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const admin = require('firebase-admin');

const app = express();
const server = http.createServer(app); 
const io = new Server(server);

// ADIÇÃO 1: Aumentado para 50mb e adicionado urlencoded para suportar imagens Base64 grandes sem dar erro 413.
app.use(express.json({ limit: '50mb' })); 
app.use(express.urlencoded({ limit: '50mb', extended: true }));
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
    console.error("❌ ERRO: Ficheiro 'firebase-key.json' não encontrado! Verifique se ele está na raiz do projeto.");
    process.exit(1);
}

// ==========================================
// 2. ROTAS DA API (BANCO DE DADOS)
// ==========================================

app.get('/', (req, res) => { res.redirect('/login.html'); });

// ----------------------------------------------------
// ROTAS GOOGLE AUTH (AUTOMATIZADO)
// ----------------------------------------------------
app.post('/api/google_login', async (req, res) => {
    const { uid } = req.body;
    try {
        const doc = await db.collection('google_users').doc(uid).get();
        if (doc.exists) {
            res.json({ sucesso: true, hasUsername: true, usuario: doc.data().usuario });
        } else {
            res.json({ sucesso: true, hasUsername: false });
        }
    } catch (error) { 
        res.json({ sucesso: false }); 
    }
});

app.post('/api/set_username', async (req, res) => {
    const { uid, username } = req.body;
    const cleanName = username.normalize("NFD").replace(/[\u0300-\u036f]/g,"").toUpperCase().replace(/[^A-Z0-9 ]/g, '').trim();
    
    if (!cleanName) return res.json({ sucesso: false, erro: "Nome inválido." });

    try {
        await db.collection('google_users').doc(uid).set({ usuario: cleanName });
        res.json({ sucesso: true, usuario: cleanName });
    } catch (error) { 
        res.json({ sucesso: false }); 
    }
});

// ----------------------------------------------------
// ROTAS DE SINCRONIZAÇÃO DO LOBBY
// ----------------------------------------------------
app.post('/api/salvar_lobby', async (req, res) => {
    const { usuario, fichas, mesas, campanhas_jogadas } = req.body;
    try {
        await db.collection('usuarios').doc(usuario).set({
            fichas: fichas || [],
            mesas: mesas || [],
            campanhas_jogadas: campanhas_jogadas || []
        }, { merge: true });
        res.json({ sucesso: true });
    } catch (error) { 
        console.error("Erro ao salvar lobby:", error);
        res.json({ sucesso: false }); 
    }
});

app.post('/api/carregar_lobby', async (req, res) => {
    const { usuario } = req.body;
    try {
        const doc = await db.collection('usuarios').doc(usuario).get();
        if (doc.exists) {
            const data = doc.data();
            res.json({ 
                sucesso: true, 
                fichas: data.fichas || [], 
                mesas: data.mesas || [], 
                campanhas_jogadas: data.campanhas_jogadas || [] 
            });
        } else {
            res.json({ sucesso: false, erro: "Usuário não encontrado." });
        }
    } catch(e) { 
        console.error("Erro ao carregar lobby:", e);
        res.json({ sucesso: false }); 
    }
});

// ----------------------------------------------------
// ROTAS DAS FICHAS E CAMPANHAS
// ----------------------------------------------------

const playersData = {}; // Cache de memória RAM

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
        
        // ADIÇÃO 2: Atualizar o cache da memória RAM do Servidor!
        // Se não fizermos isso, o mestre pode carregar dados antigos ao dar F5 na página.
        if (playersData[usuario]) {
            playersData[usuario].fullData = fichaData;
            if (fichaData.info) {
                playersData[usuario].vida_atual = fichaData.info.vida_atual;
                playersData[usuario].vida_max = fichaData.info.vida_max;
                playersData[usuario].sani_atual = fichaData.info.sani_atual;
                playersData[usuario].sani_max = fichaData.info.sani_max;
                playersData[usuario].pe_atual = fichaData.info.pe_atual;
                playersData[usuario].pe_max = fichaData.info.pe_max;
                playersData[usuario].nome = fichaData.info.char_nome;
                playersData[usuario].nex = fichaData.info.char_nex;
                playersData[usuario].foto = fichaData.info.char_img;
            }
            if (fichaData.defense) playersData[usuario].defesa = fichaData.defense;
            if (fichaData.charStatus) playersData[usuario].status = fichaData.charStatus;
        }

        console.log(`💾 Ficha [${usuario}] salva na nuvem.`);
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

app.post('/api/sair_campanha', async (req, res) => {
    const { usuario, campanha } = req.body;
    const idUnico = usuario + '_' + campanha;
    
    try {
        await db.collection('fichas_campanha').doc(idUnico).delete(); 
        if (playersData[idUnico]) { delete playersData[idUnico]; }
        io.to(campanha).emit('comando_mestre', { tipo: 'jogador_saiu', codigo: usuario });
        console.log(`🗑️ O jogador [${usuario}] saiu/foi expulso da campanha [${campanha}]. Dados limpos.`);
        res.json({ sucesso: true });
    } catch(e) {
        res.json({ sucesso: false });
    }
});


// ==========================================
// 3. COMUNICAÇÃO EM TEMPO REAL (SOCKET.IO)
// ==========================================

io.on('connection', (socket) => {
    console.log(`🟢 Utilizador ligou-se: ${socket.id}`);

    socket.on('join_campaign', (campanha) => {
        socket.join(campanha);
        socket.campanha = campanha;
        console.log(`📌 Utilizador entrou na campanha (Sala: ${campanha})`);
    });

    socket.on('novo_item_catalogo_global', (data) => {
        socket.broadcast.to(socket.campanha).emit('sync_item_catalogo_global', data);
    });

    socket.on('remover_item_catalogo_global', (data) => {
        socket.broadcast.to(socket.campanha).emit('item_removido_catalogo_global', data);
    });

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

    // Sincronização forçada enviada pela Ficha
    socket.on('mestre_force_sync', (dados) => {
        if(dados.codigo) {
            playersData[dados.codigo + '_' + socket.campanha] = dados;
            socket.broadcast.to(socket.campanha).emit('update_mestre', dados); 
            socket.broadcast.to(socket.campanha).emit('mestre_force_sync_player', dados); 
        }
    });

    // ADIÇÃO 3: Sincronização forçada enviada pelo Mestre (Quando o mestre dá um item)
    socket.on('mestre_force_sync_player', (dados) => {
        if (dados.codigo && socket.campanha) {
            const idUnico = dados.codigo + '_' + socket.campanha;
            if (playersData[idUnico] && dados.fullData) {
                playersData[idUnico].fullData = dados.fullData;
            }
        }
    });

    socket.on('comando_mestre', (dados) => {
        socket.broadcast.to(socket.campanha).emit('comando_mestre', dados);
    });
    
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
    codigo: codigo, 
    nome: f.info.char_nome, 
    foto: f.info.char_img, 
    nex: f.info.char_nex, 
    defesa: f.defense,
    vida_atual: f.info.vida_atual, 
    vida_max: f.info.vida_max, 
    sani_atual: f.info.sani_atual, 
    sani_max: f.info.sani_max,
    pe_atual: f.info.pe_atual,   // <-- ADICIONA ESTA LINHA
    pe_max: f.info.pe_max,       // <-- E ESTA LINHA
    status: f.charStatus, 
    fullData: f
};
                    playersData[idUnico] = dadosRecuperados;
                    socket.emit('update_mestre', dadosRecuperados);
                } else {
                    socket.broadcast.to(socket.campanha).emit('mestre_pede_ficha', codigo);
                }
            } catch (e) {
                console.error("Erro ao puxar dados do jogador:", e);
            }
        }
    });

    socket.on('disconnect', () => {
        console.log(`🔴 Utilizador desligou-se: ${socket.id}`);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => { 
    console.log(`🚀 Servidor a rodar na porta ${PORT}`); 
});
