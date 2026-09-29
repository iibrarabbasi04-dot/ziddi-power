var $=function(i){return document.getElementById(i)},busy=false;
var C={"Main":[["menu","Saari commands"],["ping","Speed check"],["alive","Bot zinda hai?"],["owner","Owner ki info"],["runtime","Bot kab se chal raha"],["channel","Channel ka link"]],
"Sticker aur media":[["sticker","Photo se sticker (photo bhejo ya reply)"],["toimg","Sticker se photo (reply)"],["qr","Text se QR code"]],
"Tools":[["calc","Hisab: .calc 12*(3+4)"],["time","Waqt: .time Asia/Karachi"],["flip","Sikka uchhalo"],["dice","Pasa phenko"]],
"Group (admin)":[["tagall","Sab ko tag"],["hidetag","Chupa tag"],["kick","Member nikalo"],["promote","Admin banao"],["demote","Admin hatao"],["open","Group kholo"],["close","Group band karo"],["link","Group link"],["groupinfo","Group ki info"],["antilink","Link block on/off"]],
"Owner":[["mode","public / private"],["follow","Channel follow"]]};
function draw(f){var h="";for(var k in C){var r=C[k].filter(function(c){return !f||(c[0]+c[1]).toLowerCase().indexOf(f)>-1});
if(r.length)h+='<div class="cat">'+k+'</div><div class="cmd">'+r.map(function(c){return '<div data-c=".'+c[0]+'"><b>.'+c[0]+'</b><span>'+c[1]+'</span></div>'}).join("")+'</div>'}
$("list").innerHTML=h||'<p class="note">Kuch nahi mila.</p>'}
draw("");
$("q").oninput=function(e){draw(e.target.value.toLowerCase().trim())};
$("list").onclick=function(e){var d=e.target.closest("[data-c]");if(!d)return;var v=d.getAttribute("data-c");
if(navigator.clipboard)navigator.clipboard.writeText(v);var b=d.querySelector("b");b.textContent="Copied";setTimeout(function(){b.textContent=v},1000)};
fetch("/api/stats").then(function(r){return r.json()}).then(function(d){$("stat").textContent="WhatsApp Bot · "+d.bots+" online"}).catch(function(){});
function poll(id){var t=setInterval(function(){fetch("/api/status?id="+id).then(function(r){return r.json()}).then(function(d){var m=$("pm");
if(d.status=="linked")m.textContent="Link ho gaya, bot chalu ho raha hai...";
if(d.status=="sent"){m.textContent="Ho gaya! Bot chalu hai. WhatsApp me .menu likh kar dekho.";clearInterval(t)}
if(d.status=="error"||d.status=="expired"){m.textContent=d.status=="error"?"Link nahi ho saka. Dobara try karo.":"Code expire ho gaya. Dobara code lo.";clearInterval(t);$("code").hidden=true}
}).catch(function(){})},3000)}
$("go").onclick=function(){if(busy)return;var n=$("num").value.replace(/\D/g,""),m=$("pm");
if(n.length<8){m.textContent="Sahi number likho, country code ke saath.";return}
busy=true;$("code").hidden=true;m.textContent="Code ban raha hai, 10-20 second ruko...";
fetch("/api/pair?number="+n).then(function(r){return r.json()}).then(function(d){
if(d.error){m.textContent=d.error;return}
$("codeText").textContent=d.code;$("code").hidden=false;m.textContent="Ye code 3 minute me WhatsApp me dalo.";poll(d.id)
}).catch(function(){m.textContent="Server se connection nahi hua. Site Node server par chalni chahiye (README dekho)."}).then(function(){busy=false})};
$("copy").onclick=function(){var v=$("codeText").textContent;if(navigator.clipboard)navigator.clipboard.writeText(v);$("copy").textContent="Copied";setTimeout(function(){$("copy").textContent="Copy"},1500)};
