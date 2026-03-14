const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app); 
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// Redireciona a página inicial para a ficha
app.get('/', (req, res) => {
    res.redirect('/ficha.html');
});

// Memória do servidor: guarda o último status de cada jogador por código
const playersData = {}; 

io.on('connection', (socket) => {
    console.log('🟢 Um utilizador ligou-se:', socket.id);

    // Recebe atualizações da ficha e guarda na memória do servidor
    socket.on('status_change', (dados) => {
        if(dados.codigo) {
            playersData[dados.codigo] = dados;
            io.emit('update_mestre', dados); // Partilha com todos (o mestre filtra no frontend)
        }
    });

    // NOVO: Recebe comandos do Mestre (ex: tirar vida) e envia para o Jogador
    socket.on('comando_mestre', (dados) => {
        io.emit('comando_mestre', dados);
    });

    // Recebe rolagens
    socket.on('rolagem_feita', (dados) => {
        io.emit('novo_log', dados);
    });

    // Quando o Mestre adiciona um código, o servidor envia logo a ficha se já existir na memória
    socket.on('request_player', (codigo) => {
        if(playersData[codigo]) {
            socket.emit('update_mestre', playersData[codigo]);
        }
    });

    socket.on('disconnect', () => {
        console.log('🔴 Um utilizador desligou-se:', socket.id);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Servidor a correr na porta ${PORT}!`);
});
