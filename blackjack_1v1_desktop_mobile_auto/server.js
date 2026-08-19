const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req,res)=>res.redirect('/join'));
app.get('/king', (req,res)=>res.sendFile(path.join(__dirname,'public','king.html')));
app.get('/join', (req,res)=>res.sendFile(path.join(__dirname,'public','join.html')));

const rooms = new Map();

function makeCode(){
  const chars='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code='';
  do{
    code='';
    for(let i=0;i<6;i++) code += chars[Math.floor(Math.random()*chars.length)];
  }while(rooms.has(code));
  return code;
}
function hash(s){return crypto.createHash('sha256').update(String(s)).digest('hex')}
function freshShoe(){
  const suits=['♠','♥','♦','♣'];
  const ranks=['A','2','3','4','5','6','7','8','9','10','J','Q','K'];
  const shoe=[];
  for(let d=0;d<8;d++) for(const s of suits) for(const r of ranks) shoe.push({s,r});
  for(let i=shoe.length-1;i>0;i--){
    const j=Math.floor(Math.random()*(i+1));
    [shoe[i],shoe[j]]=[shoe[j],shoe[i]];
  }
  return shoe;
}
function newPlayer(name){
  return {name,score:0,hands:[],activeHand:0,done:false,splitCount:0,connected:false,socketId:null};
}
function newGame(){
  return {round:1,phase:'waiting',shoe:freshShoe(),dealer:[],host:newPlayer('블랙잭 킹'),challenger:newPlayer('도전자'),timerDeadline:null,message:'도전자를 기다리는 중입니다.',finished:false,winner:null};
}
function makeRoom(code,password,hostToken){
  return {code,passwordHash:hash(password),hostToken,createdAt:Date.now(),game:newGame()};
}
function getRoom(code){return rooms.get(String(code||'').trim().toUpperCase())}
function draw(room){if(!room.game.shoe.length) room.game.shoe=freshShoe(); return room.game.shoe.pop()}
function handValue(hand){
  let t=0,a=0;
  for(const c of hand){
    if(c.r==='A'){t+=11;a++}
    else if(['K','Q','J'].includes(c.r)) t+=10;
    else t+=Number(c.r);
  }
  while(t>21&&a){t-=10;a--}
  return {total:t,soft:a>0};
}
function blackjack(hand){return hand.length===2 && handValue(hand).total===21}
function normalize(p){while(p.activeHand<p.hands.length&&p.hands[p.activeHand].done)p.activeHand++;p.done=p.activeHand>=p.hands.length}
function canSplit(h){
  if(!h||h.cards.length!==2)return false;
  const a=h.cards[0].r,b=h.cards[1].r,ten=r=>['10','J','Q','K'].includes(r);
  return a===b||(ten(a)&&ten(b));
}
function setTimer(room){room.game.timerDeadline=Date.now()+20000}
function pub(room){
  const g=room.game;
  return {code:room.code,round:g.round,phase:g.phase,dealer:g.dealer,host:g.host,challenger:g.challenger,timerDeadline:g.timerDeadline,message:g.message,cardsRemaining:g.shoe.length,finished:g.finished,winner:g.winner};
}
function broadcast(room){io.to('room:'+room.code).emit('state',pub(room))}

function checkFinished(room){
  const g=room.game;
  if(g.host.score>=15){g.finished=true;g.winner='블랙잭 킹';g.message='블랙잭 킹이 +15점에 먼저 도달했습니다. 블랙잭 킹 승리!'}
  else if(g.challenger.score>=15){g.finished=true;g.winner=g.challenger.name;g.message=`${g.challenger.name}이(가) +15점에 먼저 도달했습니다. 도전자 승리!`}
  else if(g.host.score<=-15){g.finished=true;g.winner=g.challenger.name;g.message=`블랙잭 킹이 -15점에 도달했습니다. ${g.challenger.name} 승리!`}
  else if(g.challenger.score<=-15){g.finished=true;g.winner='블랙잭 킹';g.message=`${g.challenger.name}이(가) -15점에 도달했습니다. 블랙잭 킹 승리!`}
  if(g.finished){g.phase='finished';g.timerDeadline=null}
}

function startRound(room){
  const g=room.game;
  if(g.finished||!g.host.connected||!g.challenger.connected)return;
  for(const p of [g.host,g.challenger]){
    p.hands=[{cards:[draw(room),draw(room)],done:false,double:false,splitAces:false}];
    p.activeHand=0;p.done=false;p.splitCount=0;
    if(blackjack(p.hands[0].cards)) p.hands[0].done=true;
  }
  g.dealer=[draw(room),draw(room)];

  // 아메리칸 블랙잭 피크: 업카드가 A 또는 10점 카드면 홀카드를 즉시 확인한다.
  // 홀카드는 이 판정 중 화면에 공개하지 않고, 실제 블랙잭일 때만 라운드 종료와 함께 공개된다.
  if((g.dealer[0].r==='A' || ['10','J','Q','K'].includes(g.dealer[0].r)) && blackjack(g.dealer)){
    resolveDealerBlackjack(room);return;
  }
  g.phase='playing';
  g.message='같은 딜러를 상대합니다. 각자 자신의 판단으로 플레이하세요.';
  normalize(g.host);normalize(g.challenger);setTimer(room);broadcast(room);finishIfReady(room);
}

function resolveDealerBlackjack(room){
  const g=room.game;
  const hd=blackjack(g.host.hands[0]?.cards||[])?0:-1;
  const cd=blackjack(g.challenger.hands[0]?.cards||[])?0:-1;
  g.host.score+=hd;g.challenger.score+=cd;g.host.done=true;g.challenger.done=true;
  g.phase='result';g.timerDeadline=null;
  g.message=`딜러 BLACKJACK · 라운드 즉시 종료 · 블랙잭 킹 ${hd>=0?'+':''}${hd}점 / ${g.challenger.name} ${cd>=0?'+':''}${cd}점`;
  checkFinished(room);broadcast(room);
}

function action(room,role,type){
  const g=room.game;if(g.phase!=='playing'||g.finished)return;
  const p=role==='host'?g.host:g.challenger;normalize(p);if(p.done)return;
  const h=p.hands[p.activeHand];if(!h||h.done||h.splitAces)return;

  if(type==='hit'){
    h.cards.push(draw(room));if(handValue(h.cards).total>=21)h.done=true;
  }else if(type==='stand'){
    h.done=true;
  }else if(type==='double'){
    if(h.cards.length!==2)return;h.double=true;h.cards.push(draw(room));h.done=true;
  }else if(type==='split'){
    if(p.splitCount>=1||!canSplit(h))return;
    const [c1,c2]=h.cards;const splitAces=c1.r==='A'&&c2.r==='A';
    p.hands.splice(p.activeHand,1,
      {cards:[c1,draw(room)],done:splitAces,double:false,splitAces},
      {cards:[c2,draw(room)],done:splitAces,double:false,splitAces}
    );
    p.splitCount++;
  }
  normalize(p);setTimer(room);broadcast(room);finishIfReady(room);
}
function dealerPlay(room){
  const g=room.game;
  while(true){const v=handValue(g.dealer);if(v.total<17)g.dealer.push(draw(room));else break;}
}
function scoreHand(room,h){
  const g=room.game,p=handValue(h.cards).total,d=handValue(g.dealer).total,pbj=blackjack(h.cards),dbj=blackjack(g.dealer);
  let r=0;
  if(p>21)r=-1;
  else if(dbj&&!pbj)r=-1;
  else if(pbj&&!dbj)return 2;
  else if(d>21)r=1;
  else if(p>d)r=1;
  else if(p<d)r=-1;
  else r=0;
  return h.double?r*2:r;
}
function settlePlayer(room,p){let d=0;for(const h of p.hands)d+=scoreHand(room,h);p.score+=d;return d}
function finishIfReady(room){
  const g=room.game;normalize(g.host);normalize(g.challenger);if(!(g.host.done&&g.challenger.done))return;
  dealerPlay(room);
  const hd=settlePlayer(room,g.host),cd=settlePlayer(room,g.challenger);
  g.phase='result';g.timerDeadline=null;
  g.message=`ROUND ${g.round} 종료 · 블랙잭 킹 ${hd>=0?'+':''}${hd}점 / ${g.challenger.name} ${cd>=0?'+':''}${cd}점`;
  checkFinished(room);broadcast(room);
}
function nextRound(room){const g=room.game;if(g.phase!=='result'||g.finished)return;g.round++;startRound(room)}

setInterval(()=>{
  const now=Date.now();
  for(const room of rooms.values()){
    const g=room.game;if(!g.timerDeadline||now<g.timerDeadline)continue;
    if(g.phase==='playing'){
      for(const p of [g.host,g.challenger]){normalize(p);if(!p.done){const h=p.hands[p.activeHand];if(h)h.done=true;normalize(p)}}
      g.message='20초 시간 초과 · 미완료 활성 핸드는 자동 STAND 처리되었습니다.';setTimer(room);broadcast(room);finishIfReady(room);
    }
  }
},250);

io.on('connection',socket=>{
  socket.on('createRoom',({password})=>{
    password=String(password||'').trim();
    if(password.length<4)return socket.emit('createRoomResult',{ok:false,message:'비밀번호는 4자 이상으로 설정하세요.'});
    const code=makeCode(),hostToken=crypto.randomBytes(24).toString('hex'),room=makeRoom(code,password,hostToken);
    rooms.set(code,room);socket.data.roomCode=code;socket.data.role='host';socket.data.hostToken=hostToken;
    room.game.host.connected=true;room.game.host.socketId=socket.id;socket.join('room:'+code);
    socket.emit('createRoomResult',{ok:true,code,hostToken,joinPath:'/join?room='+code});broadcast(room);
  });

  socket.on('resumeHost',({code,hostToken})=>{
    const room=getRoom(code);if(!room||room.hostToken!==hostToken)return socket.emit('hostResumeResult',{ok:false});
    socket.data.roomCode=room.code;socket.data.role='host';socket.data.hostToken=hostToken;room.game.host.connected=true;room.game.host.socketId=socket.id;socket.join('room:'+room.code);socket.emit('hostResumeResult',{ok:true});broadcast(room);
  });

  socket.on('joinRoom',({code,password,nickname})=>{
    const room=getRoom(code);if(!room)return socket.emit('joinRoomResult',{ok:false,message:'존재하지 않는 방입니다.'});
    if(room.passwordHash!==hash(password))return socket.emit('joinRoomResult',{ok:false,message:'방 비밀번호가 틀렸습니다.'});
    if(room.game.challenger.connected)return socket.emit('joinRoomResult',{ok:false,message:'이미 도전자가 입장해 있습니다.'});
    const clean=String(nickname||'').trim().slice(0,18);if(!clean)return socket.emit('joinRoomResult',{ok:false,message:'닉네임을 입력하세요.'});
    socket.data.roomCode=room.code;socket.data.role='challenger';room.game.challenger.connected=true;room.game.challenger.socketId=socket.id;room.game.challenger.name=clean;room.game.message='도전자 입장 완료 · 블랙잭 킹의 게임 시작을 기다리는 중입니다.';socket.join('room:'+room.code);socket.emit('joinRoomResult',{ok:true,code:room.code});broadcast(room);
  });
  socket.on('action',type=>{const room=getRoom(socket.data.roomCode);if(!room||!['host','challenger'].includes(socket.data.role)||!['hit','stand','double','split'].includes(type))return;action(room,socket.data.role,type)});
  socket.on('startGame',()=>{const room=getRoom(socket.data.roomCode);if(!room||socket.data.role!=='host')return;if(room.game.phase==='waiting'||room.game.phase==='idle')startRound(room)});
  socket.on('nextRound',()=>{const room=getRoom(socket.data.roomCode);if(!room||socket.data.role!=='host')return;nextRound(room)});

  socket.on('newMatch',({password})=>{
    const oldRoom=getRoom(socket.data.roomCode);if(!oldRoom||socket.data.role!=='host')return;
    password=String(password||'').trim();if(password.length<4)return socket.emit('newMatchResult',{ok:false,message:'새 비밀번호는 4자 이상이어야 합니다.'});
    const oldCode=oldRoom.code,challengerSocketId=oldRoom.game.challenger.socketId;
    if(challengerSocketId)io.to(challengerSocketId).emit('forcedLogout',{reason:'블랙잭 킹이 새 매치를 시작했습니다. 새 링크로 다시 입장해주세요.'});
    socket.leave('room:'+oldCode);rooms.delete(oldCode);
    let code=makeCode();while(code===oldCode||rooms.has(code))code=makeCode();
    const hostToken=crypto.randomBytes(24).toString('hex'),room=makeRoom(code,password,hostToken);
    room.game.host.connected=true;room.game.host.socketId=socket.id;room.game.message='새 매치 준비 완료 · 새 도전자를 기다리는 중입니다.';
    rooms.set(code,room);socket.join('room:'+code);socket.data.roomCode=code;socket.data.hostToken=hostToken;
    socket.emit('newMatchResult',{ok:true,code,hostToken,joinPath:'/join?room='+code});broadcast(room);
  });

  socket.on('disconnect',()=>{
    const room=getRoom(socket.data.roomCode);if(!room)return;
    if(socket.data.role==='host'){room.game.host.connected=false;room.game.message='블랙잭 킹 연결이 끊어졌습니다.'}
    if(socket.data.role==='challenger'){room.game.challenger.connected=false;room.game.message='도전자 연결이 끊어졌습니다.'}
    broadcast(room);
  });
});

server.listen(PORT,()=>console.log(`1v1 Blackjack server running on ${PORT}`));
