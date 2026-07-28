const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 3000;

// Serve static files from root directory
app.use(express.static(__dirname));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Multiplayer Rooms Data
const rooms = new Map();

function generateRoomId() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function getPublicRoomsList() {
  const list = [];
  rooms.forEach((room, id) => {
    if (!room.isPrivate) {
      list.push({
        id: id,
        name: room.name,
        mode: room.mode,
        players: room.players.size,
        maxPlayers: room.maxPlayers,
        status: room.status
      });
    }
  });
  return list;
}

io.on('connection', (socket) => {
  console.log(`[NET] Player connected: ${socket.id}`);
  let currentRoomId = null;

  // Send current room list
  socket.emit('room_list', getPublicRoomsList());

  // Create Custom Room
  socket.on('create_room', (data) => {
    const roomId = generateRoomId();
    const room = {
      id: roomId,
      name: data.name || `SORTIE-${roomId}`,
      mode: data.mode || 'ffa',
      maxPlayers: data.maxPlayers || 8,
      isPrivate: !!data.isPrivate,
      status: 'waiting',
      host: socket.id,
      players: new Map()
    };

    rooms.set(roomId, room);
    joinPlayerToRoom(socket, room, data.pilotName || 'ACE', data.airframe || 'wraith');
  });

  // Join Room
  socket.on('join_room', (data) => {
    const room = rooms.get(data.roomId);
    if (!room) {
      return socket.emit('error_msg', 'Room not found');
    }
    if (room.players.size >= room.maxPlayers) {
      return socket.emit('error_msg', 'Room is full');
    }
    joinPlayerToRoom(socket, room, data.pilotName || 'ACE', data.airframe || 'wraith');
  });

  // Quick Match
  socket.on('quick_match', (data) => {
    let targetRoom = null;
    for (const [id, room] of rooms.entries()) {
      if (!room.isPrivate && room.players.size < room.maxPlayers && room.mode === (data.mode || 'ffa')) {
        targetRoom = room;
        break;
      }
    }

    if (!targetRoom) {
      const roomId = generateRoomId();
      targetRoom = {
        id: roomId,
        name: `QUICKMATCH-${roomId}`,
        mode: data.mode || 'ffa',
        maxPlayers: 8,
        isPrivate: false,
        status: 'waiting',
        host: socket.id,
        players: new Map()
      };
      rooms.set(roomId, targetRoom);
    }

    joinPlayerToRoom(socket, targetRoom, data.pilotName || 'ACE', data.airframe || 'wraith');
  });

  function joinPlayerToRoom(socket, room, pilotName, airframe) {
    currentRoomId = room.id;
    socket.join(room.id);

    const team = room.mode === 'tdm' ? (room.players.size % 2 === 0 ? 'ALPHA' : 'BRAVO') : 'FFA';

    const playerState = {
      id: socket.id,
      name: pilotName,
      airframe: airframe,
      team: team,
      x: (Math.random() - 0.5) * 1200,
      y: (Math.random() - 0.5) * 1200,
      heading: Math.random() * Math.PI * 2,
      vx: 0,
      vy: 0,
      thr: 0.7,
      ab: false,
      hp: 100,
      maxHp: 100,
      kills: 0,
      deaths: 0,
      dead: false
    };

    room.players.set(socket.id, playerState);

    socket.emit('joined_room', {
      roomId: room.id,
      mode: room.mode,
      team: team,
      selfId: socket.id,
      players: Array.from(room.players.values())
    });

    socket.to(room.id).emit('player_joined', playerState);
    io.emit('room_list', getPublicRoomsList());
  }

  // Update Player Position / State
  socket.on('player_update', (state) => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;

    const player = room.players.get(socket.id);
    if (player) {
      Object.assign(player, state);
      socket.to(currentRoomId).emit('player_moved', player);
    }
  });

  // Cannon Fire
  socket.on('shoot_cannon', (data) => {
    if (!currentRoomId) return;
    socket.to(currentRoomId).emit('cannon_fired', {
      id: socket.id,
      x: data.x,
      y: data.y,
      heading: data.heading,
      vx: data.vx,
      vy: data.vy
    });
  });

  // Missile Launch
  socket.on('launch_missile', (data) => {
    if (!currentRoomId) return;
    socket.to(currentRoomId).emit('missile_launched', {
      id: socket.id,
      targetId: data.targetId,
      cls: data.cls,
      x: data.x,
      y: data.y,
      heading: data.heading
    });
  });

  // Drop Flare
  socket.on('drop_flare', (data) => {
    if (!currentRoomId) return;
    socket.to(currentRoomId).emit('flare_dropped', {
      id: socket.id,
      x: data.x,
      y: data.y
    });
  });

  // Player Damage / Kill
  socket.on('player_hit', (data) => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;

    const target = room.players.get(data.targetId);
    const attacker = room.players.get(socket.id);

    if (target && !target.dead) {
      target.hp = Math.max(0, target.hp - data.dmg);
      if (target.hp <= 0) {
        target.dead = true;
        target.deaths++;
        if (attacker) attacker.kills++;

        io.in(currentRoomId).emit('killfeed', {
          attackerName: attacker ? attacker.name : 'WORLD',
          targetName: target.name,
          weapon: data.weapon || '20MM CANNON'
        });
      }

      io.in(currentRoomId).emit('player_damaged', {
        targetId: data.targetId,
        hp: target.hp,
        dead: target.dead
      });
    }
  });

  // Leave / Disconnect
  socket.on('disconnect', () => {
    console.log(`[NET] Player disconnected: ${socket.id}`);
    if (currentRoomId) {
      const room = rooms.get(currentRoomId);
      if (room) {
        room.players.delete(socket.id);
        socket.to(currentRoomId).emit('player_left', socket.id);
        if (room.players.size === 0) {
          rooms.delete(currentRoomId);
        }
      }
      io.emit('room_list', getPublicRoomsList());
    }
  });
});

server.listen(PORT, () => {
  console.log(`================================================`);
  console.log(`  IRON SKIES - Multiplayer Game Server Online  `);
  console.log(`  Listening on Port: ${PORT}                   `);
  console.log(`================================================`);
});
