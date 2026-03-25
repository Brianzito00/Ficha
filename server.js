const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const admin = require('firebase-admin');

const app = express();
const server = http.createServer(app); 
const io = new Server(server);

// Aumenta o limite para suportar fichas com imagens em base64 ou textos grandes
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
    console.error("❌ ERRO: Ficheiro 'firebase-key.json' não encontrado! Verifique se ele está na raiz do projeto.");
    process.exit(1);
}

// ==========================================
// 2. ROTAS DA API (BANCO DE DADOS)
// ==========================================

app.get('/', (req, res) => { res.redirect('/login.html'); });

// ----------------------------------------------------
// ROTAS GOOGLE AUTH (ESCOLHER NOME DE UTILIZADOR)
// ----------------------------------------------------
app.post('/api/google_login', async (req, res) => {
    const { uid } = req.body;
    try {
        const doc = await db.collection('google_users').doc(uid).get();
        if (doc.exists) {
            // Já tem um nome de utilizador escolhido!
            res.json({ sucesso: true, hasUsername: true, usuario: doc.data().usuario });
        } else {
            // É a primeira vez da conta Google, tem de escolher o nome
            res.json({ sucesso: true, hasUsername: false });
        }
    } catch (error) { 
        res.json({ sucesso: false }); 
    }
});

app.post('/api/set_username', async (req, res) => {
    const { uid, username } = req.body;
    const cleanName = username.toUpperCase().replace(/[^A-Z0-9]/g, '');
    
    if (!cleanName) return res.json({ sucesso: false, erro: "Nome inválido." });

    try {
        // Grava na nuvem o link entre a conta Google (uid) e o nome escolhido
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

// Puxar Ficha de uma Campanha Específica
app.post('/api/carregar_personagem', async (req, res) => {
    const { usuario } = req.body; // Vem no formato JOAO_NOME-DA-CAMPANHA
    try {
        const doc = await db.collection('fichas_campanha').doc(usuario).get();
        if (doc.exists) res.json({ sucesso: true, ficha: doc.data().ficha });
        else res.json({ sucesso: true, ficha: null });
    } catch(e) { res.json({ sucesso: false }); }
});

// Guardar Ficha numa Campanha Específica
app.post('/api/guardar_ficha', async (req, res) => {
    const { usuario, fichaData } = req.body;
    try {
        await db.collection('fichas_campanha').doc(usuario).set({ ficha: fichaData }, { merge: true }); 
        console.log(`💾 Ficha [${usuario}] salva na nuvem.`);
        res.json({ sucesso: true });
    } catch (error) { res.json({ sucesso: false }); }
});

// Carregar Dados do Mestre e Wallpaper
app.post('/api/carregar_campanha', async (req, res) => {
    const { campanha } = req.body;
    try {
        const doc = await db.collection('campanhas').doc(campanha).get();
        if (doc.exists) res.json({ sucesso: true, dados: doc.data() });
        else res.json({ sucesso: true, dados: null });
    } catch(e) { res.json({ sucesso: false }); }
});

// Salvar Dados do Mestre e Wallpaper
app.post('/api/salvar_campanha', async (req, res) => {
    const { campanha, dados } = req.body;
    try {
        await db.collection('campanhas').doc(campanha).set(dados, { merge: true });
        res.json({ sucesso: true });
    } catch(e) { res.json({ sucesso: false }); }
});

// Remover os dados de vínculo quando o jogador é expulso pelo mestre ou sai pelo lobby
app.post('/api/sair_campanha', async (req, res) => {
    const { usuario, campanha } = req.body;
    const idUnico = usuario + '_' + campanha;
    
    try {
        await db.collection('fichas_campanha').doc(idUnico).delete(); 
        if (typeof playersData !== 'undefined') { delete playersData[idUnico]; }
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

// Memória RAM temporária para as fichas, para evitar ler a BD a toda a hora
const playersData = {}; 

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

    socket.on('mestre_force_sync', (dados) => {
        if(dados.codigo) {
            playersData[dados.codigo + '_' + socket.campanha] = dados;
            socket.broadcast.to(socket.campanha).emit('update_mestre', dados); 
            socket.broadcast.to(socket.campanha).emit('mestre_force_sync_player', dados); 
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
