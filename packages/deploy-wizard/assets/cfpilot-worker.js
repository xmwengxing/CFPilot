var Br=Object.defineProperty;var ne=(t,e,r)=>()=>{if(r)throw r[0];try{return t&&(e=t(t=0)),e}catch(n){throw r=[n],n}};var Jr=(t,e)=>{for(var r in e)Br(t,r,{get:e[r],enumerable:!0})};function J(t){let e=new Uint8Array(t);crypto.getRandomValues(e);let r="";for(let n of e)r+=de[n>>4]+de[n&15];return r}function Ye(){let t=new Uint8Array(16);crypto.getRandomValues(t),t[6]=t[6]&15|64,t[8]=t[8]&63|128;let e=[];for(let r of t)e.push(de[r>>4]+de[r&15]);return[e.slice(0,4).join(""),e.slice(4,6).join(""),e.slice(6,8).join(""),e.slice(8,10).join(""),e.slice(10,16).join("")].join("-")}function It(t){let e="abcdefghijklmnopqrstuvwxyz0123456789",r=new Uint8Array(t);crypto.getRandomValues(r);let n="";for(let o of r)n+=e[o%e.length];return n}function Tt(t){let e=new TextEncoder().encode(t),r="",n=32768;for(let o=0;o<e.length;o+=n)r+=String.fromCharCode(...e.subarray(o,o+n));return btoa(r)}async function Ut(t){let e=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(t)),r=new Uint8Array(e),n="";for(let o of r)n+=de[o>>4]+de[o&15];return n}function Xe(t,e){if(t.length!==e.length)return!1;let r=0;for(let n=0;n<t.length;n++)r|=t.charCodeAt(n)^e.charCodeAt(n);return r===0}var de,pe=ne(()=>{"use strict";de="0123456789abcdef"});function he(t,e){if(t==null)return e;let r=String(t).trim();if(r==="")return e;let n=Number(r);return Number.isFinite(n)?n:e}function me(t,e){if(t==null||t==="")return e;let r=String(t).trim().toLowerCase();return["1","true","yes","on"].includes(r)?!0:["0","false","no","off"].includes(r)?!1:e}function K(t,e){return t==null?e:String(t)}function Qr(t){return{uuid:K(t.UUID,""),trojanPassword:"",wsPath:Z.wsPath,trojanPath:Z.trojanPath,xhttpPath:Z.xhttpPath,add:K(t.ADD,""),addApi:K(t.ADDAPI,""),addCsv:K(t.ADD_CSV,""),poolOfficial:me(t.OFFICIAL_IP,Z.poolOfficial),officialCount:he(t.OFFICIAL_IP_COUNT,Z.officialCount),poolDomain:me(t.PREFERRED_DOMAIN,Z.poolDomain),domainCount:he(t.PREFERRED_DOMAIN_COUNT,Z.domainCount),poolManual:me(t.MANUAL_IP,Z.poolManual),poolCountries:K(t.POOL_COUNTRIES,Z.poolCountries),dls:he(t.DLS,0),maxLatency:he(t.MAX_LATENCY,0),maxNodes:0,proxyIp:K(t.PROXYIP,""),socks5:K(t.SOCKS5,""),httpProxy:K(t.HTTP_PROXY,""),nat64:K(t.NAT64,""),concurrentDial:me(t.TCP_CONCURRENT_DIAL,!0),enableTrojan:!0,enableXhttp:!0,subDomain:"",subProtocol:"both",subTransport:"both",clientFingerprint:Z.clientFingerprint,tlsFragment:!1,tlsFragmentSize:Z.tlsFragmentSize,tlsFragmentDelay:Z.tlsFragmentDelay}}function qe(t,e){let r={...t};for(let[n,o]of Object.entries(e))if(o!=null)if(n==="dls"||n==="maxLatency"||n==="maxNodes"||n==="officialCount"||n==="domainCount")r[n]=he(o,0);else if(n==="concurrentDial"||n==="enableTrojan"||n==="enableXhttp"||n==="tlsFragment"||n==="poolOfficial"||n==="poolDomain"||n==="poolManual")r[n]=me(o,!1);else if(n==="subProtocol"){let i=String(o);r[n]=i==="vless"||i==="trojan"||i==="both"?i:"both"}else if(n==="subTransport"){let i=String(o);r[n]=i==="ws"||i==="xhttp"||i==="both"?i:"both"}else r[n]=String(o);return r}async function Vt(t,e){let r=Qr(e),n=await t.get(Rt),o={};if(n)try{o=JSON.parse(n)}catch{o={}}let i=qe(r,o),s=!1;return i.uuid||(i.uuid=Ye(),s=!0),i.trojanPassword||(i.trojanPassword=Ye().replace(/-/g,"").slice(0,16),s=!0),i.officialCount<1&&(i.officialCount=Z.officialCount,s=!0),i.domainCount<1&&(i.domainCount=Z.domainCount,s=!0),s&&await Ke(t,i),i}async function Ke(t,e){await t.put(Rt,JSON.stringify(e))}async function ge(t){return await t.get(ue)??""}async function et(t){let e=await t.get(Be);return e?e.split(/\r?\n/).map(r=>r.trim()).filter(r=>r.length>0):[]}async function Mt(t,e){let r=e.map(n=>n.trim()).filter(n=>n.length>0);if(r.length===0){await t.delete(Be);return}await t.put(Be,r.join(`
`))}var Rt,ue,Je,Be,Ce,Ae,Ie,Te,Qe,Et,Z,be=ne(()=>{"use strict";pe();Rt="CONFIG",ue="LOCAL_PREFERRED_IPS",Je="SCANNER_TOKEN",Be="POOL_DOMAIN_LIBRARY",Ce="ONETIME:",Ae="SESSION:",Ie="PANEL_PATH",Te="ADMIN_PW_HASH",Qe="ADMIN_PW_PLAIN",Et="/cfpilot",Z={uuid:"",trojanPassword:"",wsPath:"/vless",trojanPath:"/trojan",xhttpPath:"/xhttp",add:"",addApi:"",addCsv:"",poolOfficial:!0,officialCount:20,poolDomain:!0,domainCount:10,poolManual:!1,poolCountries:"",dls:0,maxLatency:0,maxNodes:0,proxyIp:"",socks5:"",httpProxy:"",nat64:"",concurrentDial:!0,enableTrojan:!0,enableXhttp:!0,subDomain:"",subProtocol:"vless",subTransport:"ws",clientFingerprint:"chrome",tlsFragment:!1,tlsFragmentSize:"10-20",tlsFragmentDelay:"10-20"}});function X(t){let e=qr.exec(t);if(!e)return!1;for(let r=1;r<=4;r++){let n=Number(e[r]);if(!Number.isInteger(n)||n<0||n>255)return!1}return!0}function ee(t){return!t.includes(":")||!/^[0-9a-fA-F:.]+$/.test(t)?!1:Kr(t)!==null}function Kr(t){if(!t.includes(":"))return null;let e=t,r=e.lastIndexOf(":"),n=e.slice(r+1);if(n.includes(".")){if(!X(n))return null;let d=n.split(".").map(f=>Number(f));e=`${e.slice(0,r+1)}${(d[0]<<8|d[1]).toString(16)}:${(d[2]<<8|d[3]).toString(16)}`}let o=e.indexOf("::"),i,s;if(o>=0){if(e.indexOf("::",o+1)>=0)return null;let d=e.slice(0,o),f=e.slice(o+2);i=d?d.split(":"):[],s=f?f.split(":"):[]}else i=e.split(":"),s=[];let c=i.length+s.length;if(c>8)return null;let l=[],u=d=>/^[0-9a-fA-F]{1,4}$/.test(d)?parseInt(d,16):null;for(let d of i){let f=u(d);if(f===null)return null;l.push(f)}let p=8-c;for(let d=0;d<p;d++)l.push(0);for(let d of s){let f=u(d);if(f===null)return null;l.push(f)}return l.length===8?l:null}function en(t){let e=t.map(l=>(l&65535).toString(16)),r=-1,n=0,o=-1,i=0;for(let l=0;l<e.length;l++)e[l]==="0"?(o<0&&(o=l),i++,i>n&&(n=i,r=o)):(o=-1,i=0);if(n<2)return e.join(":");let s=e.slice(0,r).join(":"),c=e.slice(r+n).join(":");return`${s}::${c}`}function tn(t,e,r,n){if(e<0||e>=t.length)return null;if(r===1)return e+5>t.length?null:{hostname:`${t[e+1]}.${t[e+2]}.${t[e+3]}.${t[e+4]}`,next:e+5};if(n?r===2:r===3){if(e+2>t.length)return null;let o=t[e+1];return e+2+o>t.length?null:{hostname:new TextDecoder().decode(t.subarray(e+2,e+2+o)),next:e+2+o}}if(n?r===3:r===4){if(e+17>t.length)return null;let o=new DataView(t.buffer,t.byteOffset+e+1,16),i=[];for(let s=0;s<8;s++)i.push(o.getUint16(s*2,!1));return{hostname:en(i),next:e+17}}return null}async function Nt(t,e){let r=await t.peekExactly(1);if(!r)return null;let n=r[0],o;if(n===1)o=5;else if(e?n===2:n===3){let c=await t.peekExactly(2);if(!c)return null;o=2+c[1]}else if(e?n===3:n===4)o=17;else return null;let i=await t.peekExactly(o);if(!i)return null;let s=tn(i,0,n,e);return s?(t.skip(o),{hostname:s.hostname,addressType:n,consumed:o}):null}var qr,ve=ne(()=>{"use strict";qr=/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/});function Re(t){return $t.get(t.toUpperCase())??""}function Ot(t){return Object.prototype.hasOwnProperty.call(tt,t.toUpperCase())}var Dt,Ue,ye,tt,Lt,$t,Ft,rt=ne(()=>{"use strict";Dt=["104.17.242.168","104.27.19.224","104.17.76.217","104.16.59.243","104.17.112.167","104.17.178.202","104.16.211.40","104.19.73.179","104.18.0.20","104.16.100.111"],Ue=["173.245.48.0/20","103.21.244.0/22","103.22.200.0/22","103.31.4.0/22","141.101.64.0/18","108.162.192.0/18","190.93.240.0/20","188.114.96.0/20","197.234.240.0/22","198.41.128.0/17","162.158.0.0/15","104.16.0.0/13","104.24.0.0/14","172.64.0.0/13","131.0.72.0/22"],ye=["cf.090227.xyz","bestcf.top","cloudflare.182682.xyz","speed.marisalnc.com","freeyx.cloudflare88.eu.org","cdn.2020111.xyz","cfip.cfcdn.vip","cf.0sm.com","cf.zhetengsha.eu.org","cloudflare.9jy.cc","cf.zerone-cdn.pp.ua","cfip.1323123.xyz","cnamefuckxxs.yuchen.icu","cloudflare-ip.mofashi.ltd","115155.xyz","cname.xirancdn.us","f3058171cad.002404.xyz","8.889288.xyz","cdn.tzpro.xyz","cf.877771.xyz","xn--b6gac.eu.org"],tt={HK:["HKG"],TW:["TPE","KHH"],JP:["NRT","KIX","CTS","FUK"],KR:["ICN","PUS"],SG:["SIN"],MY:["KUL"],TH:["BKK"],VN:["SGN","HAN"],ID:["CGK","DPS"],PH:["MNL"],IN:["BOM","MAA","DEL"],AU:["SYD","MEL","BNE","PER"],NZ:["AKL"],US:["LAX","SJC","SEA","ORD","DFW","IAD","EWR","ATL","MIA","DEN","PHX","BOS"],CA:["YYZ","YVR","YYC"],GB:["LHR","MAN"],DE:["FRA","MUC","BER"],FR:["CDG","MRS"],NL:["AMS"],IT:["MXP","FCO"],ES:["MAD","BCN"],SE:["ARN"],CH:["ZRH"],AT:["VIE"],PL:["WAW"],RU:["DME","SVO"],TR:["IST"],AE:["DXB"],IL:["TLV"],ZA:["JNB"],BR:["GRU","GIG"],AR:["EZE"],CL:["SCL"],MX:["MEX"]},Lt={HK:"\u9999\u6E2F",TW:"\u53F0\u6E7E",JP:"\u65E5\u672C",KR:"\u97E9\u56FD",SG:"\u65B0\u52A0\u5761",MY:"\u9A6C\u6765\u897F\u4E9A",TH:"\u6CF0\u56FD",VN:"\u8D8A\u5357",ID:"\u5370\u5C3C",PH:"\u83F2\u5F8B\u5BBE",IN:"\u5370\u5EA6",AU:"\u6FB3\u5927\u5229\u4E9A",NZ:"\u65B0\u897F\u5170",US:"\u7F8E\u56FD",CA:"\u52A0\u62FF\u5927",GB:"\u82F1\u56FD",DE:"\u5FB7\u56FD",FR:"\u6CD5\u56FD",NL:"\u8377\u5170",IT:"\u610F\u5927\u5229",ES:"\u897F\u73ED\u7259",SE:"\u745E\u5178",CH:"\u745E\u58EB",AT:"\u5965\u5730\u5229",PL:"\u6CE2\u5170",RU:"\u4FC4\u7F57\u65AF",TR:"\u571F\u8033\u5176",AE:"\u963F\u8054\u914B",IL:"\u4EE5\u8272\u5217",ZA:"\u5357\u975E",BR:"\u5DF4\u897F",AR:"\u963F\u6839\u5EF7",CL:"\u667A\u5229",MX:"\u58A8\u897F\u54E5"},$t=new Map;for(let[t,e]of Object.entries(tt))for(let r of e)$t.set(r,t);Ft=Object.keys(tt)});function at(t){if(!/^\d{1,5}$/.test(t))return!1;let e=Number(t);return e>0&&e<=65535}function Ne(t,e=Me){let r=t.trim();if(!r||(r=r.replace(/^["']|["']$/g,"").trim(),!r||r.startsWith("#")))return null;let n="",o=r.indexOf("#");if(o>=0&&(n=r.slice(o+1).trim(),r=r.slice(0,o).trim()),!r)return null;if(r.startsWith("[")){let s=r.indexOf("]");if(s<0)return null;let c=r.slice(1,s),l=r.slice(s+1),u=e;if(l.startsWith(":")&&at(l.slice(1)))u=Number(l.slice(1));else if(l)return null;return!ee(c)&&!X(c)?null:{ip:c,port:u,remark:n}}let i=(r.match(/:/g)??[]).length;if(i>1)return ee(r)?{ip:r,port:e,remark:n}:null;if(i===1){let s=r.indexOf(":"),c=r.slice(0,s),l=r.slice(s+1);return!at(l)||!X(c)&&!ee(c)&&!Ve(c)?null:{ip:c,port:Number(l),remark:n}}return!X(r)&&!ee(r)&&!Ve(r)?null:{ip:r,port:e,remark:n}}function Ve(t){return/^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/.test(t)}function rn(t){let e=t.split(/[_-]/).filter(Boolean),r="",n=0,o=0;if(e.length>=3){let i=Number(e[e.length-2]),s=Number(e[e.length-1]);Number.isFinite(i)&&Number.isFinite(s)&&(r=e.slice(0,e.length-2).join("_"),n=i,o=s)}else if(e.length===2){let i=Number(e[1]);Number.isFinite(i)&&(r=e[0]??"",n=i)}return{colo:r,latency:n,speed:o}}function ot(t,e){let r=rn(t.remark),n=r.colo.toUpperCase();return{ip:t.ip,port:t.port,remark:t.remark,colo:n,latency:r.latency,speed:r.speed,source:e,country:Re(n)}}function nn(t){let e=[];for(let r of t.split(/\r?\n/)){let n=Ne(r);n&&e.push(ot(n,"add"))}return e}function we(t){let e=[];for(let r of t.split(/\r?\n/)){let n=Ne(r);n&&e.push(ot(n,"local"))}return e}function an(t){let e=[];for(let r of t.split(/\r?\n/)){let n=Ne(r);n&&e.push(ot(n,"addapi"))}return e}function ln(t,e){let r=t.trim().toLowerCase().replace(/[（(].*?[)）]/g,"");for(let n of e)if(r===n||r.includes(n))return 1;return 0}function xe(t,e){let r=-1,n=0;for(let o=0;o<t.length;o++){let i=ln(t[o],e);i>n&&(n=i,r=o)}return r}function nt(t){let e=t.replace(/[^\d.\-]/g,"");if(!e)return 0;let r=Number(e);return Number.isFinite(r)?r:0}function cn(t,e={}){let r=t.split(/\r?\n/).map(b=>b.trim()).filter(b=>b.length>0&&!b.startsWith("#")),n=[],o=0,i=!1,s=-1,c=-1,l=-1,u=-1,p=-1;if(r.length===0)return{entries:n,filtered:o,hasHeader:i};let d=Gt(r[0]),f=d.some(b=>X(b.trim())||ee(b.trim())),x=d.some(b=>Ht.some(S=>b.toLowerCase().includes(S))||Wt.some(S=>b.toLowerCase().includes(S))||zt.some(S=>b.toLowerCase().includes(S))),P=0;x&&!f&&(i=!0,s=xe(d,on),c=xe(d,sn),l=xe(d,Ht),u=xe(d,Wt),p=xe(d,zt),P=1);for(let b=P;b<r.length;b++){let S=Gt(r[b]);if(S.length===0)continue;let T="",U=Me,C=0,h=0,m="";if(i){if(s<0)continue;if(T=(S[s]??"").trim(),c>=0&&S[c]){let g=Number(S[c].trim());Number.isInteger(g)&&g>0&&g<=65535&&(U=g)}l>=0&&S[l]&&(C=nt(S[l])),u>=0&&S[u]&&(h=nt(S[u])),p>=0&&S[p]&&(m=S[p].trim())}else{let g=S.findIndex(M=>{let O=M.trim();return X(O)||ee(O)||O.includes(".")&&Ve(O)});if(g<0)continue;T=S[g].trim();let A=[];S.forEach((M,O)=>{if(O===g)return;let L=nt(M);M.trim()&&/[\d.]/.test(M)&&A.push({index:O,value:L,raw:M})}),A.length===1?C=A[0].value:A.length===2?(C=A[0].value,h=A[1].value):A.length===3?(at(A[0].raw.trim())&&(U=A[0].value),C=A[1].value,h=A[2].value):(h=A[A.length-2].value,C=A[A.length-1].value);let V=S.find((M,O)=>O!==g&&M.trim()&&!/[\d.]/.test(M)&&/[a-zA-Z]/.test(M));V&&(m=V.trim())}if(!T)continue;let I=Ne(T.includes(":")&&!T.includes(" ")?T:`${T}:${U}`);if(!I)continue;let k={ip:I.ip,port:I.port,remark:m,colo:m.toUpperCase(),latency:h,speed:C,source:"addcsv",country:Re(m.toUpperCase())};n.push(k)}let v=e.dls??0,y=e.maxLatency??0,w=n.filter(b=>!(v>0&&b.speed<v||y>0&&b.latency>y));return o=n.length-w.length,{entries:w,filtered:o,hasHeader:i}}function Gt(t){let e=[],r="",n=!1;for(let o=0;o<t.length;o++){let i=t[o];n?i==='"'?t[o+1]==='"'?(r+='"',o++):n=!1:r+=i:i==='"'?n=!0:i===","||i==="	"?(e.push(r.trim()),r=""):r+=i}return e.push(r.trim()),e}function Ee(t){if(t<=1)return 0;let e=new Uint32Array(1);return crypto.getRandomValues(e),e[0]%t}function dn(t){let e=t.split(".");return(Number(e[0])<<24>>>0)+(Number(e[1])<<16)+(Number(e[2])<<8)+Number(e[3])}function pn(t){let e=t>>>0;return`${e>>>24&255}.${e>>>16&255}.${e>>>8&255}.${e&255}`}function un(t,e){let r=[];for(let s of t){let[c,l]=s.split("/");if(!c||!X(c))continue;let u=Number(l);!Number.isInteger(u)||u<8||u>32||r.push({base:dn(c),hostBits:32-u})}if(r.length===0||e<=0)return[];let n=new Set,o=e*24,i=0;for(;n.size<e&&i<o;){i++;let{base:s,hostBits:c}=r[Ee(r.length)],l=2**c,u=c>=2?1+Ee(l-2):Ee(l);n.add(pn(s+u))}return[...n]}function fn(t,e=ye){let r=e.filter(n=>Ve(n));for(let n=r.length-1;n>0;n--){let o=Ee(n+1),i=r[n];r[n]=r[o],r[o]=i}return r.slice(0,Math.max(0,Math.min(t,r.length)))}function hn(t){let e=[],r=new Set,n=[...Dt];for(let o=n.length-1;o>0;o--){let i=Math.floor(Math.random()*(o+1));[n[o],n[i]]=[n[i],n[o]]}for(let o of n){if(e.length>=t)break;r.has(o)||(r.add(o),e.push(o))}if(e.length<t)for(let o of un(Ue,(t-e.length)*4)){if(e.length>=t)break;r.has(o)||(r.add(o),e.push(o))}return e.map(o=>({ip:o,port:Me,remark:"",colo:"",latency:0,speed:0,source:"official",country:""}))}function mn(t,e=ye){return fn(t,e).map(r=>({ip:r,port:Me,remark:"",colo:"",latency:0,speed:0,source:"domain",country:""}))}function gn(t){return[...new Set(t.split(/[,\s]+/).map(e=>e.trim().toUpperCase()).filter(e=>e.length===2&&Ot(e)))]}function bn(t,e){if(e.length===0)return t;let r=new Set(e);return t.filter(n=>{let o=n.country||Re(n.colo);return o!==""&&r.has(o)})}function yn(t){let e=new Set,r=[],n=0;for(let o of t)for(let i of o.entries){let s=`${i.ip}:${i.port}`;if(e.has(s)){n++;continue}e.add(s),r.push(i)}return{nodes:r,deduped:n}}async function _t(t,e){let r=await fetch(t,{signal:AbortSignal.timeout(e),headers:{"User-Agent":"CFPilot/1.1 (+https://github.com/xmwengxing/CFPilot)"}});if(!r.ok)throw new Error(`HTTP ${r.status}`);return await r.text()}function Zt(t,e,r){return Number.isFinite(t)?Math.min(r,Math.max(e,Math.trunc(t))):e}function jt(t){return t.filter(e=>e.entries.length>0).map(e=>({key:e.key,name:vn[e.key],entries:e.entries}))}async function De(t,e,r={}){let n=r.timeoutMs??6e3,o=r.budget,i=[],s=gn(t.poolCountries),c=t.poolOfficial||t.poolDomain||t.poolManual,l=c?t.poolOfficial?Zt(t.officialCount,1,200):0:20,u=c?t.poolDomain?Zt(t.domainCount,1,100):0:10,p=l>0?hn(l):[],d=u>0?mn(u,r.domainPool):[],f=we(e),x=nn(t.add),P=c?t.poolManual:!1,v=P?[...f,...x]:[];P&&v.length===0&&i.push("\u624B\u52A8\u4F18\u9009 IP \u4E3A\u7A7A\uFF1A\u8BF7\u5148\u8DD1\u4E00\u6B21\u672C\u5730\u771F\u8FDE\u63A5\u4F18\u9009\uFF0C\u6216\u5728\u300C\u624B\u52A8\u4F18\u9009\u300D\u91CC\u586B\u5165 IP");let y=[],w=t.addApi.split(/[\n,]+/).map(k=>k.trim()).filter(k=>/^https?:\/\//i.test(k));if(w.length>0&&!o?.exhausted){let k=await Promise.allSettled(w.map(g=>_t(g,n)));for(let g of k)g.status==="fulfilled"?y=y.concat(an(g.value)):i.push(`ADDAPI \u62C9\u53D6\u5931\u8D25\uFF1A${String(g.reason?.message??g.reason)}`)}let b=[],S=0,T=t.addCsv.split(/[\n,]+/).map(k=>k.trim()).filter(k=>/^https?:\/\//i.test(k));if(T.length>0&&!o?.exhausted){let k=await Promise.allSettled(T.map(g=>_t(g,n)));for(let g of k)if(g.status==="fulfilled"){let A=cn(g.value,{dls:t.dls,maxLatency:t.maxLatency});b=b.concat(A.entries),S+=A.filtered}else i.push(`ADDCSV \u62C9\u53D6\u5931\u8D25\uFF1A${String(g.reason?.message??g.reason)}`)}o?.exhausted&&i.push("CPU \u9884\u7B97\u4E0D\u8DB3\uFF0C\u5DF2\u8DF3\u8FC7\u90E8\u5206\u8FDC\u7A0B\u62C9\u53D6");let U=[{key:"official",entries:p},{key:"domain",entries:d},{key:"manual",entries:v},{key:"api",entries:y},{key:"csv",entries:b}],C=jt(U);if(s.length>0&&C.length>0){let k=C.reduce((A,V)=>A+V.entries.length,0);C=C.map(A=>({...A,entries:bn(A.entries,s)})).filter(A=>A.entries.length>0);let g=C.reduce((A,V)=>A+V.entries.length,0);g===0?(C=jt(U),i.push(`\u56FD\u5BB6\u7B5B\u9009\uFF08${s.join("/")}\uFF09\u540E\u65E0\u53EF\u7528\u8282\u70B9\uFF1A\u968F\u673A\u4F18\u9009 IP \u7684\u673A\u623F\u672A\u77E5\uFF0C\u8BF7\u5148\u8DD1\u4E00\u6B21\u672C\u5730\u4F18\u9009\u518D\u6309\u56FD\u5BB6\u7B5B\u9009\uFF1B\u5DF2\u5FFD\u7565\u8BE5\u7B5B\u9009`)):g<k&&i.push(`\u56FD\u5BB6\u7B5B\u9009\uFF08${s.join("/")}\uFF09\u5DF2\u6392\u9664 ${k-g} \u6761\u673A\u623F\u672A\u77E5\u6216\u5730\u533A\u4E0D\u5339\u914D\u7684\u8282\u70B9`)}let{nodes:h,deduped:m}=yn(C);return{nodes:t.maxNodes>0?h.slice(0,t.maxNodes):h,groups:C,stats:{official:p.length,domain:d.length,local:P?f.length:0,add:P?x.length:0,addapi:y.length,addcsv:b.length,filtered:S,deduped:m,countries:s,errors:i}}}function it(t){return t.groups&&t.groups.length>0?t.groups:[{key:"official",name:"\u8282\u70B9",entries:t.nodes}]}function ke(t,e,r,n=""){let o=t.remark&&!/^[\d.]+$/.test(t.remark)?t.remark:t.ip,i=t.colo&&t.colo!==o?` ${t.colo}`:"";return`${n?`${n} `:""}${o}${i} #${r+1}${e==="trojan"?" Trojan":""}`}function Xt(t){return t.includes(":")?`[${t}]`:t}function Yt(t,e,r,n){let o=r==="xhttp"?e.config.xhttpPath:e.config.wsPath,i=new URLSearchParams;i.set("encryption","none"),i.set("security","tls"),i.set("sni",e.domain),i.set("type",r),i.set("host",e.domain),i.set("path",o),r==="xhttp"&&i.set("mode","stream-one");let s=encodeURIComponent(n??ke(t,"vless",e.nodes.indexOf(t)));return`${["vle","ss"].join("")}://${e.config.uuid}@${Xt(t.ip)}:${t.port}?${i.toString()}#${s}`}function xn(t,e,r){let n=new URLSearchParams;n.set("security","tls"),n.set("sni",e.domain),n.set("type","ws"),n.set("host",e.domain),n.set("path",e.config.trojanPath);let o=encodeURIComponent(r??ke(t,"trojan",e.nodes.indexOf(t)));return`${["tro","jan"].join("")}://${encodeURIComponent(e.config.trojanPassword)}@${Xt(t.ip)}:${t.port}?${n.toString()}#${o}`}function ae(t){return`"${t.replace(/\\/g,"\\\\").replace(/"/g,'\\"')}"`}function wn(t){let e=[],r=[],n=[],o=t.protocol==="vless"||t.protocol==="both",i=t.protocol==="trojan"||t.protocol==="both";for(let s of it(t))s.entries.forEach((c,l)=>{let u=`${s.name} ${ke(c,"vless",l,"")}`;if(o&&(n.push(u),r.push([`  - name: ${ae(u)}`,"    type: vless",`    uuid: ${t.config.uuid}`,`    server: ${c.ip}`,`    port: ${c.port}`,"    network: ws","    tls: true",`    servername: ${t.domain}`,`    client-fingerprint: ${t.config.clientFingerprint}`,"    ws-opts:",`      path: ${ae(t.config.wsPath)}`,"      headers:",`        Host: ${t.domain}`].join(`
`))),i){let p=`${u} Trojan`;n.push(p),r.push([`  - name: ${ae(p)}`,"    type: trojan",`    password: ${ae(t.config.trojanPassword)}`,`    server: ${c.ip}`,`    port: ${c.port}`,"    network: ws","    tls: true",`    sni: ${t.domain}`,`    client-fingerprint: ${t.config.clientFingerprint}`,"    ws-opts:",`      path: ${ae(t.config.trojanPath)}`,"      headers:",`        Host: ${t.domain}`].join(`
`))}});if(e.push("# CFPilot \u81EA\u52A8\u751F\u6210\u8BA2\u9605"),e.push("port: 7890"),e.push("socks-port: 7891"),e.push("allow-lan: false"),e.push("mode: rule"),e.push("log-level: info"),e.push("external-controller: 127.0.0.1:9090"),e.push(""),e.push("proxies:"),r.length===0?e.push("  []"):e.push(...r),e.push(""),e.push("proxy-groups:"),e.push('  - name: "CFPilot"'),e.push("    type: select"),e.push("    proxies:"),e.push('      - "\u81EA\u52A8\u9009\u62E9"'),e.push('      - "\u6545\u969C\u8F6C\u79FB"'),n.length===0)e.push("      []");else for(let s of n)e.push(`      - ${ae(s)}`);if(n.length>0){e.push(""),e.push('  - name: "\u81EA\u52A8\u9009\u62E9"'),e.push("    type: url-test"),e.push('    url: "http://www.gstatic.com/generate_204"'),e.push("    interval: 300"),e.push("    tolerance: 50"),e.push("    proxies:");for(let s of n)e.push(`      - ${ae(s)}`);e.push(""),e.push('  - name: "\u6545\u969C\u8F6C\u79FB"'),e.push("    type: fallback"),e.push('    url: "http://www.gstatic.com/generate_204"'),e.push("    interval: 300"),e.push("    proxies:");for(let s of n)e.push(`      - ${ae(s)}`)}return e.push(""),e.push("rules:"),e.push("  - GEOIP,CN,DIRECT"),e.push("  - MATCH,CFPilot"),e.push(""),e.join(`
`)}function kn(t){let e=[],r=[],n=t.protocol==="vless"||t.protocol==="both",o=t.protocol==="trojan"||t.protocol==="both";for(let s of it(t)){let c=[];s.entries.forEach((l,u)=>{let p=`${s.name} ${ke(l,"vless",u,"")}`,d=`${p} Trojan`;n&&c.push(p),o&&c.push(d),n&&e.push({type:"vless",tag:p,server:l.ip,server_port:l.port,uuid:t.config.uuid,tls:{enabled:!0,server_name:t.domain,insecure:!1,utls:{enabled:!0,fingerprint:t.config.clientFingerprint}},transport:{type:"ws",path:t.config.wsPath,headers:{Host:t.domain}}}),o&&e.push({type:"trojan",tag:d,server:l.ip,server_port:l.port,password:t.config.trojanPassword,tls:{enabled:!0,server_name:t.domain,insecure:!1,utls:{enabled:!0,fingerprint:t.config.clientFingerprint}},transport:{type:"ws",path:t.config.trojanPath,headers:{Host:t.domain}}})}),c.length>0&&r.push({tag:s.name,members:c})}e.push({type:"direct",tag:"direct"});for(let s of r)e.push({type:"selector",tag:s.tag,outbounds:s.members,default:s.members[0]});return e.push({type:"selector",tag:"CFPilot",outbounds:r.length>0?r.map(s=>s.tag):["direct"],default:r.length>0?r[0].tag:"direct"}),JSON.stringify({log:{level:"info",timestamp:!0},dns:{servers:[{tag:"dns-out",address:"https://1.1.1.1/dns-query"},{tag:"local",address:"local"}],rules:[{rule_set:[],server:"dns-out"}]},inbounds:[{type:"mixed",tag:"mixed-in",listen:"127.0.0.1",listen_port:2080}],outbounds:e,route:{rules:[{domain_suffix:[".cn"],outbound:"direct"}],final:"CFPilot",auto_detect_interface:!0}},null,2)}function Pn(t){let e=[];for(let r of it(t))r.entries.forEach((n,o)=>{let i=ke(n,"vless",o,r.name);(t.protocol==="vless"||t.protocol==="both")&&((t.transport==="ws"||t.transport==="both")&&e.push(Yt(n,t,"ws",`${i} WS`)),(t.transport==="xhttp"||t.transport==="both")&&e.push(Yt(n,t,"xhttp",`${i} XHTTP`))),(t.protocol==="trojan"||t.protocol==="both")&&e.push(xn(n,t,`${i} Trojan`))});return Tt(e.join(`
`))}function Bt(t,e){switch(t){case"clash":return{body:wn(e),contentType:"text/yaml; charset=utf-8",fileName:"CFPilot.yaml"};case"singbox":return{body:kn(e),contentType:"application/json; charset=utf-8",fileName:"CFPilot.json"};default:return{body:Pn(e),contentType:"text/plain; charset=utf-8",fileName:"CFPilot.txt"}}}var Me,on,sn,Ht,Wt,zt,vn,st=ne(()=>{"use strict";ve();pe();rt();Me=443;on=["ip\u5730\u5740","ip \u5730\u5740","ip","\u5730\u5740","\u670D\u52A1\u5668","server","host"],sn=["\u7AEF\u53E3","port"],Ht=["\u4E0B\u8F7D\u901F\u5EA6","\u901F\u5EA6","speed","download"],Wt=["\u5E73\u5747\u5EF6\u8FDF","\u5EF6\u8FDF","latency","delay","\u54CD\u5E94\u65F6\u95F4","rtt"],zt=["colo","\u673A\u623F","\u6570\u636E\u4E2D\u5FC3","\u5730\u533A","region"];vn={official:"\u5B98\u65B9\u4F18\u9009IP",domain:"\u4F18\u9009\u57DF\u540D",manual:"\u624B\u52A8\u4F18\u9009IP",api:"\u8FDC\u7A0BAPI",csv:"\u6D4B\u901FCSV"}});async function pt(t,e){return await Ut(`${e}:${t}`)}function Kt(t){return`/${t.trim().replace(/^\/+/,"")}`}async function tr(t,e,r){let n=await t.get(Ie)??"",o=r&&r.trim()?Kt(r):"";o?n!==o&&(n=o,await t.put(Ie,n)):n||(n=Kt(`${Et}-${It(6)}`),await t.put(Ie,n));let i=await t.get(Te)??"",s=null,c=e&&e.trim()?e.trim():"";if(c){let l=J(8);i=`${l}:${await pt(c,l)}`,await t.put(Te,i),await t.delete(Qe)}else if(!i){let l=`cfp-${J(8)}`,u=J(8);i=`${u}:${await pt(l,u)}`,await t.put(Te,i),s=l,await t.put(Qe,l)}return{panelPath:n,passwordHash:i,generatedPassword:s}}async function rr(t,e){let[r,n]=t.passwordHash.split(":");if(!r||!n)return!1;let o=await pt(e,r);return Xe(o,n)}function nr(t){let e=t.headers.get("Cookie")??"",r={};for(let n of e.split(";")){let o=n.indexOf("=");if(o<0)continue;let i=n.slice(0,o).trim(),s=n.slice(o+1).trim();i&&(r[i]=decodeURIComponent(s))}return r}async function ar(t){let e=J(24);return await t.put(`${Ae}${e}`,JSON.stringify({ua:"",t:Date.now()}),er),e}async function ut(t,e){let r=nr(e)[Oe];return r?!!await t.get(`${Ae}${r}`):!1}function or(t,e=er){return`${Oe}=${t}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${e}`}function ir(){return`${Oe}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`}async function sr(t,e){let r=nr(e)[Oe];r&&await t.delete(`${Ae}${r}`)}async function lr(t){let e=J(20);return await t.put(`${Ce}${e}`,"1",In),e}async function cr(t,e){if(!e)return!1;let r=await t.get("SCANNER_TOKEN");return r&&Xe(r,e)?!0:await t.get(`${Ce}${e}`)?(await t.delete(`${Ce}${e}`),!0):!1}var Oe,er,In,ft=ne(()=>{"use strict";be();pe();Oe="cfpilot_sess",er=3600*24,In=600});async function gt(t,e,r){let n=t.getReader(),o=e.getWriter();try{for(;!r?.exhausted;){let{done:i,value:s}=await n.read();if(i)break;!s||s.byteLength===0||await o.write(s)}}catch{}finally{try{await o.close()}catch{}try{n.releaseLock()}catch{}}}var He,bt=ne(()=>{"use strict";He=class{start=performance.now();limitMs;constructor(e=8){this.limitMs=e}get elapsedMs(){return performance.now()-this.start}get exhausted(){return this.elapsedMs>this.limitMs}get remainingMs(){return this.limitMs-this.elapsedMs}check(){if(this.exhausted)throw new Error(`CPU \u9884\u7B97\u8D85\u9650\uFF08${this.limitMs}ms\uFF09\uFF0C\u5DF2\u63D0\u524D\u4E2D\u6B62`)}}});var ur={};Jr(ur,{API_PREFIX:()=>vt,getScannerToken:()=>Rn,handleApi:()=>En});function j(t,e=200,r={}){return new Response(JSON.stringify(t),{status:e,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store",...r}})}function Q(t,e){return j({ok:!1,error:t},e)}async function Rn(t,e){let r=await t.get(Je);if(r)return r;if(typeof e.SCANNER_TOKEN=="string"&&e.SCANNER_TOKEN)return e.SCANNER_TOKEN;let n=J(24);return await t.put(Je,n),n}async function En(t,e,r){if(!e.pathname.startsWith(vt))return null;let{store:n,env:o,config:i,auth:s}=r,c=e.pathname.slice(vt.length)||"/",l=t.method.toUpperCase();if(c==="/session"&&l==="GET"){let p=await ut(n,t);return j({ok:!0,authenticated:p,panelPath:s.panelPath})}if(c==="/login"&&l==="POST"){let p="";try{let x=await t.json();p=String(x.password??"")}catch{return Q("\u8BF7\u6C42\u4F53\u89E3\u6790\u5931\u8D25",400)}if(!p)return Q("\u8BF7\u8F93\u5165\u5BC6\u7801",400);if(!await rr(s,p))return Q("\u5BC6\u7801\u9519\u8BEF",401);let f=await ar(n);return j({ok:!0},200,{"Set-Cookie":or(f)})}if(c==="/logout"&&l==="POST")return await sr(n,t),j({ok:!0},200,{"Set-Cookie":ir()});if(c==="/preferred-ips"&&l==="POST"){let p=t.headers.get("Authorization")??"",d=p.startsWith("Bearer ")?p.slice(7).trim():p.trim();if(!await cr(n,d))return Q("Token \u6821\u9A8C\u5931\u8D25",401);let x;try{x=await t.json()}catch{return Q("\u8BF7\u6C42\u4F53\u89E3\u6790\u5931\u8D25",400)}let P=Array.isArray(x.ips)?x.ips.map(y=>String(y)):[],v=P.map(y=>y.trim()).filter(y=>y.length>0).join(`
`);return await n.put(ue,v),j({ok:!0,count:P.length})}if(!await ut(n,t))return Q("\u672A\u767B\u5F55\u6216\u4F1A\u8BDD\u5DF2\u8FC7\u671F",401);if(c==="/status"&&l==="GET"){let p=await ge(n),d=we(p);return j({ok:!0,panelPath:s.panelPath,domain:e.hostname,colo:t.cf?.colo??"UNK",localIps:d.length,generatedPassword:s.generatedPassword,version:"0.1.0"})}if(c==="/config"&&l==="GET")return j({ok:!0,config:i});if(c==="/config"&&l==="PUT"){let p;try{p=await t.json()}catch{return Q("\u8BF7\u6C42\u4F53\u89E3\u6790\u5931\u8D25",400)}if(!p.config||typeof p.config!="object")return Q("\u7F3A\u5C11\u914D\u7F6E\u5BF9\u8C61",400);let d=qe(i,p.config);return await Ke(n,d),r.onConfigChanged(),j({ok:!0,config:d})}if(c==="/ips"&&l==="GET"){let p=await ge(n),d=we(p);return j({ok:!0,raw:p,count:d.length,entries:d})}if(c==="/ips"&&l==="DELETE")return await n.delete(ue),j({ok:!0});if(c==="/nodes"&&l==="GET"){let p=new He(8),d=await ge(n),f=await et(n),x=await De(i,d,{budget:p,domainPool:f.length>0?f:void 0});return j({ok:!0,count:x.nodes.length,nodes:x.nodes.slice(0,200),groups:x.groups.map(P=>({key:P.key,name:P.name,count:P.entries.length})),stats:x.stats})}if(c==="/pool/meta"&&l==="GET"){let p=await et(n);return j({ok:!0,countries:Ft.map(d=>({code:d,name:Lt[d]??d})),limits:{officialCount:200,domainCount:100},builtin:{cidrs:Ue.length,domains:ye.length},customDomains:p})}if(c==="/pool/library"&&l==="PUT"){let p;try{p=await t.json()}catch{return Q("\u8BF7\u6C42\u4F53\u89E3\u6790\u5931\u8D25",400)}let d=Array.isArray(p.domains)?p.domains.map(f=>String(f)):[];return await Mt(n,d),j({ok:!0,count:d.filter(f=>f.trim()).length})}if(c==="/scanner-token"&&l==="POST"){let p=await lr(n);return j({ok:!0,token:p,expiresIn:600})}return c==="/events"&&l==="GET"?await Vn(t,n):Q("\u63A5\u53E3\u4E0D\u5B58\u5728",404)}async function Vn(t,e){let r=new TextEncoder,n="",o,i=new ReadableStream({async start(s){let c=()=>{o&&clearTimeout(o);try{s.close()}catch{}};t.signal.addEventListener("abort",c);let l=async()=>{try{let u=await ge(e);if(u!==n){n=u;let p=we(u).length;s.enqueue(r.encode(`event: ips
data: ${JSON.stringify({count:p})}

`))}else s.enqueue(r.encode(`: keepalive

`))}catch{}t.signal.aborted||(o=setTimeout(()=>{l()},3e3))};await l()},cancel(){o&&clearTimeout(o)}});return new Response(i,{status:200,headers:{"Content-Type":"text/event-stream; charset=utf-8","Cache-Control":"no-store",Connection:"keep-alive","X-Accel-Buffering":"no"}})}var vt,fr=ne(()=>{"use strict";ft();be();st();rt();pe();bt();vt="/api/v1"});be();st();pe();var Sn=15*1024*1024,Cn=2*1024*1024;async function Le(t){let e=new URL(t.url);if(t.headers.get("Upgrade")?.toLowerCase()==="websocket"){let l=new WebSocketPair,[u,p]=Object.values(l);return p.accept(),p.addEventListener("message",d=>{let f=typeof d.data=="string"?d.data:"";if(f==="PING"||f==="ping"){p.send(JSON.stringify({pong:!0,colo:t.cf?.colo??"UNK",clientIp:t.headers.get("CF-Connecting-IP")??""}));try{p.close(1e3,"Probe complete")}catch{}}}),new Response(null,{status:101,webSocket:u})}let n=Number.parseInt(e.searchParams.get("bytes")??"",10),o=Number.isFinite(n)&&n>0?Math.min(n,Sn):Cn,i=new Uint8Array(64*1024);for(let l=0;l<i.length;l++)i[l]=97;let s=0,c=new ReadableStream({pull(l){if(s>=o){l.close();return}let u=Math.min(i.byteLength,o-s);l.enqueue(i.subarray(0,u)),s+=u}});return new Response(c,{status:200,headers:{"Content-Type":"application/octet-stream","Cache-Control":"no-store","Access-Control-Allow-Origin":"*","X-Probe-Bytes":String(o),"X-Probe-Nonce":J(4)}})}var Jt="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";var $e=null;function An(t){let e=atob(t),r=new Uint8Array(new ArrayBuffer(e.length));for(let n=0;n<e.length;n++)r[n]=e.charCodeAt(n);return r}async function Qt(){if($e!==null)return $e;let t=An(Jt),e=new Response(t).body;if(!e)throw new Error("\u9762\u677F\u6570\u636E\u635F\u574F");let r=e.pipeThrough(new DecompressionStream("gzip"));return $e=await new Response(r).text(),$e}function lt(t){let e=t===200?"Welcome":t===404?"Not Found":"Service Unavailable",r=`<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${e}</title><style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f7f8fa;color:#333;font-family:-apple-system,"Segoe UI","PingFang SC",sans-serif}.c{text-align:center}h1{font-size:22px;font-weight:600;margin:0 0 10px}p{color:#888;font-size:14px;margin:0}</style></head><body><div class="c"><h1>${e}</h1><p>This site is up and running.</p></div></body></html>`;return new Response(r,{status:t,headers:{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}})}function fe(t,e){return new Response(JSON.stringify({ok:!1,error:t}),{status:e,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"}})}var ct=class{constructor(e){this.kv=e}kv;async get(e){return await this.kv.get(e)}async put(e,r,n){n&&n>=60?await this.kv.put(e,r,{expirationTtl:n}):await this.kv.put(e,r)}async delete(e){await this.kv.delete(e)}async list(e){let r=[],n;do{let o=await this.kv.list({prefix:e,cursor:n});for(let i of o.keys)r.push(i.name);n=o.list_complete?void 0:o.cursor}while(n);return r}},dt=class{data=new Map;async get(e){let r=this.data.get(e);return r?r.expiresAt>0&&r.expiresAt<=Date.now()?(this.data.delete(e),null):r.value:null}async put(e,r,n){let o=n?Date.now()+n*1e3:0;this.data.set(e,{value:r,expiresAt:o})}async delete(e){this.data.delete(e)}async list(e){return[...this.data.keys()].filter(r=>r.startsWith(e))}};function qt(t){return t.KV?new ct(t.KV):new dt}be();ft();var Tn=15e3,Un=6e4,B={config:null,configAt:0,auth:null,authAt:0};function ht(t){return qt(t)}async function Fe(t,e){if(B.config&&Date.now()-B.configAt<Tn)return B.config;let r=await Vt(t,e);return B.config=r,B.configAt=Date.now(),r}function dr(){B.config=null,B.configAt=0}async function mt(t,e){if(B.auth&&Date.now()-B.authAt<Un)return B.auth;let r=await tr(t,e.PANEL_PASSWORD,e.PANEL_PATH);return B.auth=r,B.authAt=Date.now(),r}function pr(t){switch((t??"").toLowerCase()){case"clash":case"mihomo":case"yaml":return"clash";case"singbox":case"sing-box":case"json":return"singbox";case"v2ray":return"v2ray";default:return"base64"}}var yt=null;async function Mn(){return yt||(yt=await Promise.resolve().then(()=>(fr(),ur))),yt}async function Nn(t,e,r,n){let o=await Fe(r,n),i=e.pathname.slice(5).split("/")[0]??"";if(!(i===o.uuid||i===o.trojanPassword||e.searchParams.get("token")===o.uuid))return fe("\u8BA2\u9605\u4EE4\u724C\u65E0\u6548",403);let c=pr(e.searchParams.get("target")??e.searchParams.get("format")),l=await r.get(ue)??"",u=await De(o,l),p=o.subDomain||n.DATA_HOST||e.hostname,d={nodes:u.nodes,groups:u.groups,config:o,domain:p,port:443,protocol:o.subProtocol,transport:o.subTransport},f=Bt(c,d);return new Response(f.body,{status:200,headers:{"Content-Type":f.contentType,"Cache-Control":"no-store","Content-Disposition":`inline; filename="${f.fileName}"`,"Profile-Title":"CFPilot","Subscription-Userinfo":""}})}async function hr(t,e){let r=new URL(t.url),n=ht(e);if(t.method==="OPTIONS")return new Response(null,{status:204,headers:{"Access-Control-Allow-Origin":"*","Access-Control-Allow-Methods":"GET, POST, PUT, DELETE, OPTIONS","Access-Control-Allow-Headers":"Content-Type, Authorization","Access-Control-Max-Age":"86400"}});if(r.pathname==="/__edge_probe")return Le(t);if(r.pathname.startsWith("/api/")){let{handleApi:i}=await Mn(),s=await i(t,r,{store:n,env:e,config:await Fe(n,e),auth:await mt(n,e),onConfigChanged:dr});if(s)return s}if(r.pathname==="/sub"||r.pathname.startsWith("/sub/"))return await Nn(t,r,n,e);let o=await mt(n,e);return r.pathname===o.panelPath||r.pathname===`${o.panelPath}/`?new Response(await Qt(),{status:200,headers:{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store","X-Content-Type-Options":"nosniff","Referrer-Policy":"no-referrer"}}):null}async function mr(t){let e=ht(t);return await Fe(e,t)}import{connect as Dn}from"cloudflare:sockets";var a=atob,Ln=new RegExp("^("+a("c29ja3M1")+"|http|https|ss):\\/\\/(.+)$","i"),za=new RegExp(a("Y2xhc2g=")+"|"+a("c2luZ2JveA==")+"|"+a("c2luZy1ib3g=")+"|"+a("c3VyZ2U=")+"|"+a("c3VyZmJvYXJk")+"|"+a("bG9vbg==")+"|"+a("cXVhbnR1bXVsdA==")),Ga=new RegExp(a("a2FyaW5n"),"i"),_a=new RegExp("(?:"+a("dmxlc3M=")+"|"+a("dHJvamFu")+"):\\/\\/[^@\\s/]+@(\\[[0-9a-fA-F:]+\\]|[A-Za-z0-9.-]+)(?::(\\d{1,5}))?"),Za=new RegExp("^"+a("dmxlc3M=")+":\\/\\/");var gr="CFNext";var ja=a("UEFJQ05J")+"/"+a("Q0ZOZXh0");var H="application/octet-stream",We="text/yaml; charset=utf-8",Ya={Tracking:{url:"https://github.com/"+a("NjY2T1M=")+"/rules/raw/release/"+a("bWlob21v")+"/domain/Tracking.mrs",ct:H},Advertising:{url:"https://github.com/"+a("NjY2T1M=")+"/rules/raw/release/"+a("bWlob21v")+"/domain/Advertising.mrs",ct:H},AWAvenueAds:{url:"https://raw.githubusercontent.com/"+a("VEctVHdpbGlnaHQ=")+"/"+a("QVdBdmVudWU=")+"-Ads-Rule/main/Filters/"+a("QVdBdmVudWU=")+"-Ads-Rule-"+a("Q2xhc2g=")+".yaml",ct:We},Direct:{url:"https://github.com/"+a("NjY2T1M=")+"/rules/raw/release/"+a("bWlob21v")+"/domain/Direct.mrs",ct:H},Private:{url:"https://github.com/"+a("NjY2T1M=")+"/rules/raw/release/"+a("bWlob21v")+"/domain/Private.mrs",ct:H},Download:{url:"https://github.com/"+a("NjY2T1M=")+"/rules/raw/release/"+a("bWlob21v")+"/domain/Download.mrs",ct:H},AppleCN:{url:"https://github.com/"+a("NjY2T1M=")+"/rules/raw/release/"+a("bWlob21v")+"/domain/AppleCN.mrs",ct:H},China:{url:"https://cdn.jsdelivr.net/gh/"+a("YmxhY2ttYXRyaXg3")+"/"+a("aW9zX3J1bGVfc2NyaXB0")+"@master/rule/"+a("Q2xhc2g=")+"/ChinaMaxNoIP/ChinaMaxNoIP_No_Resolve.yaml",ct:We},AI:{url:"https://github.com/"+a("NjY2T1M=")+"/rules/raw/release/"+a("bWlob21v")+"/domain/AI.mrs",ct:H},Telegram:{url:"https://github.com/"+a("NjY2T1M=")+"/rules/raw/release/"+a("bWlob21v")+"/domain/Telegram.mrs",ct:H},Twitter:{url:"https://github.com/"+a("NjY2T1M=")+"/rules/raw/release/"+a("bWlob21v")+"/domain/Twitter.mrs",ct:H},SocialMedia:{url:"https://github.com/"+a("NjY2T1M=")+"/rules/raw/release/"+a("bWlob21v")+"/domain/SocialMedia.mrs",ct:H},Netflix:{url:"https://github.com/"+a("NjY2T1M=")+"/rules/raw/release/"+a("bWlob21v")+"/domain/Netflix.mrs",ct:H},[a("WW91VHViZQ==")]:{url:"https://github.com/"+a("NjY2T1M=")+"/rules/raw/release/"+a("bWlob21v")+"/domain/"+a("WW91VHViZQ==")+".mrs",ct:H},Google:{url:"https://github.com/"+a("NjY2T1M=")+"/rules/raw/release/"+a("bWlob21v")+"/domain/Google.mrs",ct:H},Microsoft:{url:"https://cdn.jsdelivr.net/gh/"+a("YmxhY2ttYXRyaXg3")+"/"+a("aW9zX3J1bGVfc2NyaXB0")+"@master/rule/"+a("Q2xhc2g=")+"/Microsoft/Microsoft.yaml",ct:We},Proxy:{url:"https://github.com/"+a("NjY2T1M=")+"/rules/raw/release/"+a("bWlob21v")+"/domain/Proxy.mrs",ct:H},Spotify:{url:"https://github.com/"+a("RHVzdGluV2lu")+"/"+a("cnVsZXNldF9nZW9kYXRh")+"/releases/download/"+a("bWlob21v")+"-ruleset/spotify.mrs",ct:H},TikTok:{url:"https://github.com/"+a("RHVzdGluV2lu")+"/"+a("cnVsZXNldF9nZW9kYXRh")+"/releases/download/"+a("bWlob21v")+"-ruleset/tiktok.mrs",ct:H},disney:{url:"https://github.com/"+a("RHVzdGluV2lu")+"/"+a("cnVsZXNldF9nZW9kYXRh")+"/releases/download/"+a("bWlob21v")+"-ruleset/disney.mrs",ct:H},github:{url:"https://rule.kelee.one/"+a("Q2xhc2g=")+"/GitHub.yaml",ct:We},PrivateIP:{url:"https://github.com/"+a("NjY2T1M=")+"/rules/raw/release/"+a("bWlob21v")+"/ip/Private.mrs",ct:H},TelegramIP:{url:"https://github.com/"+a("NjY2T1M=")+"/rules/raw/release/"+a("bWlob21v")+"/ip/Telegram.mrs",ct:H},[a("UHJveHlJUA==")]:{url:"https://github.com/"+a("NjY2T1M=")+"/rules/raw/release/"+a("bWlob21v")+"/ip/Proxy.mrs",ct:H},ChinaIP:{url:"https://github.com/"+a("NjY2T1M=")+"/rules/raw/release/"+a("bWlob21v")+"/ip/China.mrs",ct:H}};var $n=["173.245.48.0/20","103.21.244.0/22","103.22.200.0/22","103.31.4.0/22","141.101.64.0/18","108.162.192.0/18","190.93.240.0/20","188.114.96.0/20","197.234.240.0/22","198.41.128.0/17","162.158.0.0/15","104.16.0.0/13","104.24.0.0/14","172.64.0.0/13","131.0.72.0/22"];var Vr=["2400:cb00::/32","2606:4700::/32","2803:f800::/32","2405:b500::/32","2405:8100::/32","2a06:98c0::/29","2c0f:f248::/32"];var Xa=Vr.slice();function On(t){if(!le(t=String(t||"")))return!1;if(t.indexOf(":")>=0)return Vr.some(n=>(function(o,i){let[s,c]=i.split("/"),l=parseInt(c,10),u=d=>{let f=d.indexOf("::"),x;if(f>=0){let P=d.slice(0,f).split(":").filter(Boolean),v=d.slice(f+2).split(":").filter(Boolean),y=8-P.length-v.length;x=[...P,...Array(y).fill("0"),...v]}else x=d.split(":");return x.map(P=>P.padStart(4,"0"))},p=d=>d.map(f=>parseInt(f,16).toString(2).padStart(16,"0")).join("");return p(u(o)).slice(0,l)===p(u(s)).slice(0,l)})(t,n));let e=t.split(".").map(Number),r=(e[0]<<24|e[1]<<16|e[2]<<8|e[3])>>>0;return Wn.some(([n,o])=>r>=n&&r<=o)}var kt={HK:"\u9999\u6E2F",TW:"\u53F0\u6E7E",MO:"\u6FB3\u95E8",JP:"\u65E5\u672C",SG:"\u65B0\u52A0\u5761",US:"\u7F8E\u56FD",KR:"\u97E9\u56FD",DE:"\u5FB7\u56FD",FR:"\u6CD5\u56FD",GB:"\u82F1\u56FD",CA:"\u52A0\u62FF\u5927",AU:"\u6FB3\u5927\u5229\u4E9A",SE:"\u745E\u5178",NL:"\u8377\u5170",FI:"\u82AC\u5170",NO:"\u632A\u5A01",DK:"\u4E39\u9EA6",CH:"\u745E\u58EB",IT:"\u610F\u5927\u5229",ES:"\u897F\u73ED\u7259",PT:"\u8461\u8404\u7259",IE:"\u7231\u5C14\u5170",BE:"\u6BD4\u5229\u65F6",AT:"\u5965\u5730\u5229",PL:"\u6CE2\u5170",CZ:"\u6377\u514B",RO:"\u7F57\u9A6C\u5C3C\u4E9A",HU:"\u5308\u7259\u5229",GR:"\u5E0C\u814A",RU:"\u4FC4\u7F57\u65AF",TR:"\u571F\u8033\u5176",UA:"\u4E4C\u514B\u5170",IN:"\u5370\u5EA6",TH:"\u6CF0\u56FD",MY:"\u9A6C\u6765\u897F\u4E9A",VN:"\u8D8A\u5357",PH:"\u83F2\u5F8B\u5BBE",ID:"\u5370\u5C3C",BR:"\u5DF4\u897F",MX:"\u58A8\u897F\u54E5",AR:"\u963F\u6839\u5EF7",CL:"\u667A\u5229",ZA:"\u5357\u975E",EG:"\u57C3\u53CA",AE:"\u963F\u8054\u914B",IL:"\u4EE5\u8272\u5217",NZ:"\u65B0\u897F\u5170",KZ:"\u54C8\u8428\u514B\u65AF\u5766",SA:"\u6C99\u7279"},Mr={};for(let t in kt)Mr[kt[t]]=t;Mr.\u5370\u5EA6\u5C3C\u897F\u4E9A="ID";var Fn={HKG:"\u9999\u6E2F",TPE:"\u53F0\u6E7E",KHH:"\u53F0\u6E7E",TSA:"\u53F0\u6E7E",RMQ:"\u53F0\u6E7E",NRT:"\u65E5\u672C",KIX:"\u65E5\u672C",HND:"\u65E5\u672C",CTS:"\u65E5\u672C",FUK:"\u65E5\u672C",SIN:"\u65B0\u52A0\u5761",ICN:"\u97E9\u56FD",KUL:"\u9A6C\u6765\u897F\u4E9A",BKK:"\u6CF0\u56FD",MNL:"\u83F2\u5F8B\u5BBE",SGN:"\u8D8A\u5357",HAN:"\u8D8A\u5357",CGK:"\u5370\u5C3C",DEL:"\u5370\u5EA6",BOM:"\u5370\u5EA6",MAA:"\u5370\u5EA6",DXB:"\u963F\u8054\u914B",TLV:"\u4EE5\u8272\u5217",RUH:"\u6C99\u7279",JED:"\u6C99\u7279",DOH:"\u5361\u5854\u5C14",FRA:"\u5FB7\u56FD",MUC:"\u5FB7\u56FD",DUS:"\u5FB7\u56FD",HAM:"\u5FB7\u56FD",BER:"\u5FB7\u56FD",CGN:"\u5FB7\u56FD",STR:"\u5FB7\u56FD",AMS:"\u8377\u5170",CDG:"\u6CD5\u56FD",MRS:"\u6CD5\u56FD",NCE:"\u6CD5\u56FD",LHR:"\u82F1\u56FD",LGW:"\u82F1\u56FD",MAN:"\u82F1\u56FD",MAD:"\u897F\u73ED\u7259",BCN:"\u897F\u73ED\u7259",MXP:"\u610F\u5927\u5229",FCO:"\u610F\u5927\u5229",PMO:"\u610F\u5927\u5229",ZRH:"\u745E\u58EB",GVA:"\u745E\u58EB",VIE:"\u5965\u5730\u5229",WAW:"\u6CE2\u5170",PRG:"\u6377\u514B",ARN:"\u745E\u5178",CPH:"\u4E39\u9EA6",OSL:"\u632A\u5A01",HEL:"\u82AC\u5170",DUB:"\u7231\u5C14\u5170",LIS:"\u8461\u8404\u7259",BRU:"\u6BD4\u5229\u65F6",BUD:"\u5308\u7259\u5229",OTP:"\u7F57\u9A6C\u5C3C\u4E9A",ATH:"\u5E0C\u814A",IST:"\u571F\u8033\u5176",SVO:"\u4FC4\u7F57\u65AF",DME:"\u4FC4\u7F57\u65AF",LED:"\u4FC4\u7F57\u65AF",JFK:"\u7F8E\u56FD",EWR:"\u7F8E\u56FD",LAX:"\u7F8E\u56FD",SJC:"\u7F8E\u56FD",SFO:"\u7F8E\u56FD",SEA:"\u7F8E\u56FD",ORD:"\u7F8E\u56FD",DFW:"\u7F8E\u56FD",IAD:"\u7F8E\u56FD",ATL:"\u7F8E\u56FD",MIA:"\u7F8E\u56FD",BOS:"\u7F8E\u56FD",DEN:"\u7F8E\u56FD",PHX:"\u7F8E\u56FD",MSP:"\u7F8E\u56FD",DTW:"\u7F8E\u56FD",PHL:"\u7F8E\u56FD",CLT:"\u7F8E\u56FD",LAS:"\u7F8E\u56FD",PDX:"\u7F8E\u56FD",SLC:"\u7F8E\u56FD",SAN:"\u7F8E\u56FD",AUS:"\u7F8E\u56FD",IAH:"\u7F8E\u56FD",MCI:"\u7F8E\u56FD",BNA:"\u7F8E\u56FD",SMF:"\u7F8E\u56FD",RDU:"\u7F8E\u56FD",YYZ:"\u52A0\u62FF\u5927",YVR:"\u52A0\u62FF\u5927",YUL:"\u52A0\u62FF\u5927",YOW:"\u52A0\u62FF\u5927",YYC:"\u52A0\u62FF\u5927",MEX:"\u58A8\u897F\u54E5",GRU:"\u5DF4\u897F",GIG:"\u5DF4\u897F",EZE:"\u963F\u6839\u5EF7",SCL:"\u667A\u5229",SYD:"\u6FB3\u5927\u5229\u4E9A",MEL:"\u6FB3\u5927\u5229\u4E9A",BNE:"\u6FB3\u5927\u5229\u4E9A",PER:"\u6FB3\u5927\u5229\u4E9A",AKL:"\u65B0\u897F\u5170",JNB:"\u5357\u975E",CAI:"\u57C3\u53CA",ALA:"\u54C8\u8428\u514B\u65AF\u5766",ALB:"\u7F8E\u56FD",BDL:"\u7F8E\u56FD",BHM:"\u7F8E\u56FD",BIL:"\u7F8E\u56FD",BOI:"\u7F8E\u56FD",BUF:"\u7F8E\u56FD",BUR:"\u7F8E\u56FD",BTV:"\u7F8E\u56FD",BWI:"\u7F8E\u56FD",CAE:"\u7F8E\u56FD",CHA:"\u7F8E\u56FD",CLE:"\u7F8E\u56FD",CMH:"\u7F8E\u56FD",CPR:"\u7F8E\u56FD",DAL:"\u7F8E\u56FD",DAY:"\u7F8E\u56FD",DSM:"\u7F8E\u56FD",DTT:"\u7F8E\u56FD",ECP:"\u7F8E\u56FD",EYW:"\u7F8E\u56FD",FLL:"\u7F8E\u56FD",GRR:"\u7F8E\u56FD",GSP:"\u7F8E\u56FD",HIO:"\u7F8E\u56FD",HNL:"\u7F8E\u56FD",ICT:"\u7F8E\u56FD",IND:"\u7F8E\u56FD",JAX:"\u7F8E\u56FD",LBB:"\u7F8E\u56FD",MCO:"\u7F8E\u56FD",MDW:"\u7F8E\u56FD",MEM:"\u7F8E\u56FD",MFE:"\u7F8E\u56FD",MFR:"\u7F8E\u56FD",MSY:"\u7F8E\u56FD",OAK:"\u7F8E\u56FD",OKC:"\u7F8E\u56FD",OMA:"\u7F8E\u56FD",ONT:"\u7F8E\u56FD",ORF:"\u7F8E\u56FD",PIT:"\u7F8E\u56FD",PSC:"\u7F8E\u56FD",PVD:"\u7F8E\u56FD",RIC:"\u7F8E\u56FD",RNO:"\u7F8E\u56FD",RSW:"\u7F8E\u56FD",SAT:"\u7F8E\u56FD",SDF:"\u7F8E\u56FD",SNA:"\u7F8E\u56FD",STL:"\u7F8E\u56FD",SWF:"\u7F8E\u56FD",SYR:"\u7F8E\u56FD",TPA:"\u7F8E\u56FD",TUL:"\u7F8E\u56FD",TUS:"\u7F8E\u56FD",CTS:"\u65E5\u672C",FUK:"\u65E5\u672C",HND:"\u65E5\u672C",BLR:"\u5370\u5EA6",CMB:"\u65AF\u91CC\u5170\u5361",KWI:"\u79D1\u5A01\u7279",AMM:"\u7EA6\u65E6",BEY:"\u9ECE\u5DF4\u5AE9",NBO:"\u80AF\u5C3C\u4E9A",LOS:"\u5C3C\u65E5\u5229\u4E9A",ACC:"\u52A0\u7EB3",CPT:"\u5357\u975E",LIM:"\u79D8\u9C81",BOG:"\u54E5\u4F26\u6BD4\u4E9A",PTY:"\u5DF4\u62FF\u9A6C"},Ba=Object.assign({},kt,Fn,{USA:"\u7F8E\u56FD"});var Ja=["https://"+a("YmVzdGNm")+".pages.dev/random-region/HK/100.txt","https://"+a("YmVzdGNm")+".pages.dev/random-region/TW/100.txt","https://"+a("YmVzdGNm")+".pages.dev/random-region/JP/100.txt","https://"+a("YmVzdGNm")+".pages.dev/random-region/SG/100.txt","https://"+a("YmVzdGNm")+".pages.dev/random-region/US/100.txt","https://"+a("YmVzdGNm")+".pages.dev/random-region/KR/100.txt"].join(`
`);var Qa={uuid:"",path:"",admin:"",login:"",adminInit:!1,host:"",enableVless:!0,enableTrojan:!1,trojanPassword:"",enableXhttp:!1,[a("YWxwbg==")]:"",ech:!1,echHost:"cloudflare-ech.com",echDns:"",tlsOnly:!1,nodeLimit:!0,nodeLimitCount:300,countryLabel:"",loadBalance:!0,ipv6Mode:"off",cpuLimit:!1,cfAccountId:"",cfApiToken:"",quotaAuto:!1,quotaStrict:!1,tgBotToken:"",tgChatID:"",homeWan:!1,homeWanNodes:[],[a("cHJveHlJUA==")]:"",outboundProxy:"",outboundMode:"",[a("d2FycEZyb250")]:"",mode:"",warpEnable:!1,warpConf:"",warpEps:"",warpName:"",masqueEnable:!1,masqueConf:"",masqueName:"",masqueNet:"",preferredDomains:"https://"+a("YmVzdGNm")+`.pages.dev/random-region/HK/100.txt
https://`+a("YmVzdGNm")+`.pages.dev/random-region/TW/100.txt
https://`+a("YmVzdGNm")+`.pages.dev/random-region/JP/100.txt
https://`+a("YmVzdGNm")+`.pages.dev/random-region/SG/100.txt
https://`+a("YmVzdGNm")+`.pages.dev/random-region/US/100.txt
https://`+a("YmVzdGNm")+".pages.dev/random-region/KR/100.txt",preferredIPs:[],optimizer:{source:"wetest_v4",sourceURL:"",fallbackPool:"",port:443,threads:5,count:20,useCidr:!0,fillCount:0,subMode:"",subRandomCount:16,subIncludeDefault:!1},filter:{region:"all",ipType:["IPv4"],isp:["\u79FB\u52A8","\u8054\u901A","\u7535\u4FE1"]}};var qa=[{label:"\u9999\u6E2F",region:"HK",url:"https://"+a("YmVzdGNm")+".pages.dev/random-region/HK/100.txt",count:12},{label:"\u65E5\u672C",region:"JP",url:"https://"+a("YmVzdGNm")+".pages.dev/random-region/JP/100.txt",count:12},{label:"\u7F8E\u56FD",region:"US",url:"https://"+a("YmVzdGNm")+".pages.dev/random-region/US/100.txt",count:12},{label:"\u65B0\u52A0\u5761",region:"SG",url:"https://"+a("YmVzdGNm")+".pages.dev/random-region/SG/100.txt",count:12},{label:"\u53F0\u6E7E",region:"TW",url:"https://"+a("YmVzdGNm")+".pages.dev/random-region/TW/100.txt",count:12}];var Ka=["cloudflare.182682.xyz","speed.marisalnc.com","freeyx.cloudflare88.eu.org",a("YmVzdGNm")+".top","cdn.2020111.xyz","cfip.cfcdn.vip","cf.0sm.com","cf."+a("MDkwMjI3")+".xyz","cf.zhetengsha.eu.org","cloudflare.9jy.cc","cf.zerone-cdn.pp.ua","cfip.1323123.xyz","cnamefuckxxs.yuchen.icu","cloudflare-ip.mofashi.ltd","115155.xyz","cname.xirancdn.us","f3058171cad.002404.xyz","8.889288.xyz","cdn.tzpro.xyz","cf.877771.xyz","xn--b6gac.eu.org",a("YmVzdGNm")+"."+a("MDMwMTAx")+".xyz","cdns.doon.eu.org","fn.130519.xyz","saas.sin.fan"].join(`
`);var eo={wetest_v4:{label:"\u5FAE\u6D4B\u7F51 IPv4",url:"https://www.wetest.vip/page/cloudflare/address_v4.html"},wetest_v6:{label:"\u5FAE\u6D4B\u7F51 IPv6",url:"https://www.wetest.vip/page/cloudflare/address_v6.html"},[a("YmVzdGNm")]:{label:"\u4F18\u9009 IP \u5217\u8868",url:"https://cf."+a("MDkwMjI3")+".xyz/ip.164746.xyz"},hostmonit:{label:"HostMonit \u4F18\u9009",url:"https://stock.hostmonit.com/CloudFlareYes"},wetest_cname:{label:"\u5FAE\u6D4B\u7F51 \u4F18\u9009\u57DF\u540D",url:"https://www.wetest.vip/page/cloudflare/cname.html"}},te=new TextEncoder,oe=new TextDecoder;function se(t,e){return(t<<e|t>>>32-e)>>>0}function Pe(t,e=443){if(!(t=String(t||"").trim()))return{host:"",port:e};if(t.startsWith("[")){let n=t.match(/^\[([^\]]+)\](?::(\d+))?$/);return{host:n?n[1]:t.replace(/^\[|\]$/g,""),port:n&&n[2]?parseInt(n[2]):e}}let r=t.lastIndexOf(":");return r>0&&/^\d+$/.test(t.slice(r+1))?{host:t.slice(0,r),port:parseInt(t.slice(r+1))}:{host:t,port:e}}function le(t){if(!(t=String(t||"").trim()))return!1;let e=t.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);if(e)return e.slice(1).every(o=>Number(o)<=255);if(!/^[0-9a-fA-F:]+$/.test(t)||(t.match(/::/g)||[]).length>1)return!1;let r=t.includes("::"),n=t.replace(/::/g,":").split(":").filter(Boolean);return!(!r&&n.length!==8)&&(!r||!(n.length<1||n.length>7))&&n.every(o=>/^[0-9a-fA-F]{1,4}$/.test(o))}function Nr(t){let e=[];for(let s=0;s<16;s+=2)e.push((t[s]<<8|t[s+1]).toString(16));let r=-1,n=0,o=-1,i=0;for(let s=0;s<8;s++)e[s]==="0"?(o<0?(o=s,i=1):i++,i>n&&(n=i,r=o)):(o=-1,i=0);if(n>=2){let s=e.slice(0,r).join(":");return(s?s+"::":"::")+e.slice(r+n).join(":")}return e.join(":")}function Hn(t){let[e,r]=t.split("/"),n=e.split(".").map(Number),o=(n[0]<<24|n[1]<<16|n[2]<<8|n[3])>>>0,i=r>=32?0:4294967295<<32-r>>>0;return[(o&i)>>>0,(o|~i>>>0)>>>0]}var Wn=$n.map(Hn);function br(t){try{let e=atob(String(t).replace(/-/g,"+").replace(/_/g,"/")),r=new Uint8Array(e.length);for(let n=0;n<e.length;n++)r[n]=e.charCodeAt(n);return new TextDecoder("utf-8").decode(r)}catch{return null}}function zn(t){if(!t||t.byteLength<1)throw new Error(a("VkxFU1M=")+" \u5934\u90E8\u8FC7\u77ED");let e=new DataView(t.buffer,t.byteOffset,t.byteLength),r=0;if(e.getUint8(0)!==0)throw new Error("\u4E0D\u652F\u6301\u7684 "+a("VkxFU1M=")+" \u7248\u672C");if(r+=17,r>=t.byteLength)throw new Error(a("VkxFU1M=")+" \u5934\u90E8\u8FC7\u77ED");let n=e.getUint8(r);if(r+=1,r+=n,r+3>t.byteLength)throw new Error(a("VkxFU1M=")+" \u5934\u90E8\u8FC7\u77ED");let o=e.getUint8(r);r+=1;let i=e.getUint16(r);r+=2;let s=e.getUint8(r);r+=1;let{addr:c,len:l}=(function(u,p,d,f){if(f===1)return{addr:`${p.getUint8(d)}.${p.getUint8(d+1)}.${p.getUint8(d+2)}.${p.getUint8(d+3)}`,len:4};if(f===2){let x=p.getUint8(d),P=u.subarray(d+1,d+1+x);return{addr:oe.decode(P),len:1+x}}if(f===3)return{addr:Nr(u.subarray(d,d+16)),len:16};throw new Error("\u65E0\u6CD5\u8BC6\u522B\u7684\u5730\u5740\u7C7B\u578B")})(t,e,r,s);return r+=l,{command:o,port:i,addr:c,headerLength:r,earlyData:t.subarray(r)}}var Gn=[1116352408,1899447441,3049323471,3921009573,961987163,1508970993,2453635748,2870763221,3624381080,310598401,607225278,1426881987,1925078388,2162078206,2614888103,3248222580,3835390401,4022224774,264347078,604807628,770255983,1249150122,1555081692,1996064986,2554220882,2821834349,2952996808,3210313671,3336571891,3584528711,113926993,338241895,666307205,773529912,1294757372,1396182291,1695183700,1986661051,2177026350,2456956037,2730485921,2820302411,3259730800,3345764771,3516065817,3600352804,4094571909,275423344,430227734,506948616,659060556,883997877,958139571,1322822218,1537002063,1747873779,1955562222,2024104815,2227730452,2361852424,2428436474,2756734187,3204031479,3329325298],vr="",yr="";function xr(t){return t!==vr&&(vr=t,yr=(function(e){let r=te.encode(String(e)),n=8*r.length,o=1+(r.length+8>>6)<<6,i=new Uint8Array(o);i.set(r),i[r.length]=128;let s=new DataView(i.buffer);s.setUint32(o-8,Math.floor(n/4294967296),!1),s.setUint32(o-4,n>>>0,!1);let c=3238371032,l=914150663,u=812702999,p=4144912697,d=4290775857,f=1750603025,x=1694076839,P=3204075428,v=(w,b)=>w>>>b|w<<32-b;for(let w=0;w<o;w+=64){let b=new Uint32Array(64);for(let g=0;g<16;g++)b[g]=s.getUint32(w+4*g,!1);for(let g=16;g<64;g++){let A=v(b[g-15],7)^v(b[g-15],18)^b[g-15]>>>3,V=v(b[g-2],17)^v(b[g-2],19)^b[g-2]>>>10;b[g]=b[g-16]+A+b[g-7]+V>>>0}let S=c,T=l,U=u,C=p,h=d,m=f,I=x,k=P;for(let g=0;g<64;g++){let A=k+(v(h,6)^v(h,11)^v(h,25))+(h&m^~h&I)+Gn[g]+b[g]>>>0,V=S&T^S&U^T&U;k=I,I=m,m=h,h=C+A>>>0,C=U,U=T,T=S,S=A+((v(S,2)^v(S,13)^v(S,22))+V>>>0)>>>0}c=c+S>>>0,l=l+T>>>0,u=u+U>>>0,p=p+C>>>0,d=d+h>>>0,f=f+m>>>0,x=x+I>>>0,P=P+k>>>0}let y="";for(let w of[c,l,u,p,d,f,x])y+=(w>>>24&255).toString(16).padStart(2,"0"),y+=(w>>>16&255).toString(16).padStart(2,"0"),y+=(w>>>8&255).toString(16).padStart(2,"0"),y+=(255&w).toString(16).padStart(2,"0");return y})(t)),yr}var _n=["https://doh.pub/dns-query","https://dns.alidns.com/resolve","https://1.1.1.1/dns-query","https://8.8.8.8/dns-query","https://dns.google/dns-query","https://cloudflare-dns.com/dns-query"];function Zn(t){let e=String(t).split("::"),r=e[0]?e[0].split(":").filter(Boolean):[],n=e[1]?e[1].split(":").filter(Boolean):[],o=[...r,...Array(Math.max(0,8-r.length-n.length)).fill("0"),...n],i=new Uint8Array(16);return o.forEach((s,c)=>{let l=parseInt(s,16)||0;i[2*c]=l>>8&255,i[2*c+1]=255&l}),i}async function _e(t,e,r){let n=Dn({hostname:t,port:e});try{await(function(o,i){return Promise.race([o,new Promise((s,c)=>setTimeout(()=>c(new Error("\u8FDE\u63A5\u8D85\u65F6\uFF08SYN \u88AB\u9759\u9ED8\u4E22\u5F03\uFF09")),i||6e3))])})(n.opened,r||6e3)}catch(o){try{n.close()}catch{}throw o}return n}async function xt(t,e){return _e(t.hostname,t.port,e||6e3)}function wt(t){let e=t instanceof Uint8Array?t:new Uint8Array(t),r=e.length,n=8*r,o=new Uint8Array(1+(r+8>>6)<<6);o.set(e),o[r]=128;let i=new DataView(o.buffer);i.setUint32(o.length-8,Math.floor(n/4294967296),!1),i.setUint32(o.length-4,n>>>0,!1);let s=1732584193,c=4023233417,l=2562383102,u=271733878,p=3285377520,d=new Uint32Array(80);for(let P=0;P<o.length;P+=64){for(let T=0;T<16;T++)d[T]=i.getUint32(P+4*T,!1);for(let T=16;T<80;T++)d[T]=se(d[T-3]^d[T-8]^d[T-14]^d[T-16],1);let v=s,y=c,w=l,b=u,S=p;for(let T=0;T<80;T++){let U,C;T<20?(U=y&w|~y&b,C=1518500249):T<40?(U=y^w^b,C=1859775393):T<60?(U=y&w|y&b|w&b,C=2400959708):(U=y^w^b,C=3395469782);let h=se(v,5)+U+S+C+d[T]>>>0;S=b,b=w,w=se(y,30),y=v,v=h}s=s+v>>>0,c=c+y>>>0,l=l+w>>>0,u=u+b>>>0,p=p+S>>>0}let f=new Uint8Array(20),x=new DataView(f.buffer);return x.setUint32(0,s,!1),x.setUint32(4,c,!1),x.setUint32(8,l,!1),x.setUint32(12,u,!1),x.setUint32(16,p,!1),f}function wr(t,e){let r=t;r.length>64&&(r=wt(r));let n=new Uint8Array(64),o=new Uint8Array(64);for(let i=0;i<64;i++)n[i]=54^(i<r.length?r[i]:0),o[i]=92^(i<r.length?r[i]:0);return wt($(o,wt($(n,e))))}function kr(t,e,r){let n=wr(e&&e.length?e:new Uint8Array(20),t),o=new Uint8Array(0),i=new Uint8Array(0);for(let s=1;i.length<r;s++){let c=new Uint8Array([s]);o=wr(n,$($(o,te.encode("ss-subkey")),c)),i=$(i,o)}return i.slice(0,r)}function jn(t,e,r){let n=new Uint32Array(16);n[0]=1634760805,n[1]=857760878,n[2]=2036477234,n[3]=1797285236;let o=new DataView(t.buffer,t.byteOffset,32);for(let p=0;p<8;p++)n[4+p]=o.getUint32(4*p,!0);n[12]=e>>>0;let i=new DataView(r.buffer,r.byteOffset,12);n[13]=i.getUint32(0,!0),n[14]=i.getUint32(4,!0),n[15]=i.getUint32(8,!0);let s=n.slice(),c=(p,d,f,x)=>{s[p]=s[p]+s[d]>>>0,s[x]=se(s[x]^s[p],16),s[f]=s[f]+s[x]>>>0,s[d]=se(s[d]^s[f],12),s[p]=s[p]+s[d]>>>0,s[x]=se(s[x]^s[p],8),s[f]=s[f]+s[x]>>>0,s[d]=se(s[d]^s[f],7)};for(let p=0;p<10;p++)c(0,4,8,12),c(1,5,9,13),c(2,6,10,14),c(3,7,11,15),c(0,5,10,15),c(1,6,11,12),c(2,7,8,13),c(3,4,9,14);let l=new Uint8Array(64),u=new DataView(l.buffer);for(let p=0;p<16;p++)s[p]=s[p]+n[p]>>>0,u.setUint32(4*p,s[p],!0);return l}function ze(t,e,r,n){let o=n.slice(),i=Math.ceil(n.length/64);for(let s=0;s<i;s++){let c=jn(t,r+s,e),l=64*s,u=Math.min(64,o.length-l);for(let p=0;p<u;p++)o[l+p]^=c[p]}return o}function Pr(t,e){let r=0n,n=0n;for(let c=0;c<16;c++)r|=BigInt(t[c])<<BigInt(8*c),n|=BigInt(t[16+c])<<BigInt(8*c);r&=0x0ffffffc0ffffffc0ffffffc0fffffffn;let o=0n,i=(1n<<130n)-5n;for(let c=0;c<e.length;c+=16){let l=1n;for(let u=Math.min(16,e.length-c)-1;u>=0;u--)l=l<<8n|BigInt(e[c+u]);o=(o+l)*r%i}o=o+n&(1n<<128n)-1n;let s=new Uint8Array(16);for(let c=0;c<16;c++)s[c]=Number(o>>BigInt(8*c)&0xffn);return s}async function Sr(t,e){let r=new Uint8Array(12),n=()=>{let i=r.slice();for(let s=11;s>=0&&(i[s]++,i[s]===0);s--);return i};if(a("Q0hBQ0hBMjA=")+"-POLY1305"===t)return{seal:i=>(function(s,c,l){let u=new Uint8Array(0),p=ze(s,c,0,new Uint8Array(32)),d=ze(s,c,1,l),f=v=>new Uint8Array((16-v%16)%16),x=v=>{let y=new Uint8Array(8),w=new DataView(y.buffer);return w.setUint32(0,v>>>0,!0),w.setUint32(4,Math.floor(v/4294967296),!0),y},P=$(u,$(f(u.length),$(d,$(f(d.length),$(x(u.length),x(d.length))))));return $(d,Pr(p,P))})(e,n(),i),open(i){let s=(function(c,l,u){if(u.length<16)throw new Error("SS AEAD \u6570\u636E\u8FC7\u77ED");let p=u.subarray(0,u.length-16),d=u.subarray(u.length-16),f=new Uint8Array(0),x=w=>new Uint8Array((16-w%16)%16),P=w=>{let b=new Uint8Array(8),S=new DataView(b.buffer);return S.setUint32(0,w>>>0,!0),S.setUint32(4,Math.floor(w/4294967296),!0),b},v=Pr(ze(c,l,0,new Uint8Array(32)),$(f,$(x(f.length),$(p,$(x(p.length),$(P(f.length),P(p.length))))))),y=0;for(let w=0;w<16;w++)y|=v[w]^d[w];return y!==0?null:ze(c,l,1,p)})(e,n(),i);if(!s)throw new Error("SS AEAD \u89E3\u5BC6\u5931\u8D25\uFF08\u5BC6\u7801/\u52A0\u5BC6\u65B9\u5F0F\u4E0E\u670D\u52A1\u5668\u4E0D\u5339\u914D\uFF09");return s}};let o=await crypto.subtle.importKey("raw",e,{name:t},!1,["encrypt","decrypt"]);return{seal:async i=>new Uint8Array(await crypto.subtle.encrypt({name:t,iv:n()},o,i)),async open(i){try{return new Uint8Array(await crypto.subtle.decrypt({name:t,iv:n()},o,i))}catch{throw new Error("SS AEAD \u89E3\u5BC6\u5931\u8D25\uFF08\u5BC6\u7801/\u52A0\u5BC6\u65B9\u5F0F\u4E0E\u670D\u52A1\u5668\u4E0D\u5339\u914D\uFF09")}}}}async function Cr(t,e){let r=new Uint8Array([e.length>>8&255,255&e.length]);return $(await t.seal(r),await t.seal(e))}function $(t,e){let r=new Uint8Array(t.length+e.length);return r.set(t,0),r.set(e,t.length),r}function Yn(t,e){e:for(let r=0;r<=t.length-e.length;r++){for(let n=0;n<e.length;n++)if(t[r+n]!==e[n])continue e;return r}return-1}var Y="cmliussss.net",Ar={HK:a("cHJveHlpcA==")+".hk."+Y,US:a("cHJveHlpcA==")+".us."+Y,SG:a("cHJveHlpcA==")+".sg."+Y,JP:a("cHJveHlpcA==")+".jp."+Y,KR:a("cHJveHlpcA==")+".kr."+Y,DE:a("cHJveHlpcA==")+".de."+Y,SE:a("cHJveHlpcA==")+".se."+Y,NL:a("cHJveHlpcA==")+".nl."+Y,FI:a("cHJveHlpcA==")+".fi."+Y,GB:a("cHJveHlpcA==")+".gb."+Y,Oracle:a("cHJveHlpcA==")+".oracle."+Y,DigitalOcean:a("cHJveHlpcA==")+".digitalocean."+Y,Vultr:a("cHJveHlpcA==")+".vultr."+Y,Multacom:a("cHJveHlpcA==")+".multacom."+Y},Ir=(()=>{let t=Object.create(null),e=(r,n)=>{for(let o of[].concat(n))t[o]=r};return e("HK","HKG"),e("AU",["SYD","MEL","BNE","PER","ADL","CBR"]),e("SG","SIN"),e("JP",["NRT","HND","KIX","TYO","OSA","NGO","CTS","FUK","OKA"]),e("KR",["ICN","SEL","PUS"]),e("DE",["FRA","MUC","DUS","BER","HAM","STR","VIE","ZRH","CDG","MAD","MXP","FCO","PRG","WAW"]),e("SE","ARN"),e("NL","AMS"),e("FI","HEL"),e("GB",["LHR","LGW","MAN","EDI"]),e("US",["LAX","SJC","SFO","SEA","PDX","SAN","LAS","PHX","SLC","DEN","DFW","IAH","AUS","ORD","MSP","DTW","STL","MCI","ATL","MIA","MCO","BNA","CLT","IAD","BOS","EWR","JFK","PHL","YYZ","YVR","YUL","MEX","GRU"]),e("TW",["TPE","KHH","TSA","RMQ"]),t})(),Tr=t=>{let e=String(t||"").toUpperCase();return e?Ir[e]?Ir[e]:/^[A-Z]{2}$/.test(e)?e:"US":"US"},Ge=new Map,Xn=t=>{let e=String(t||"").trim();if(!e)return[];let r=Ge.get(e);if(r)return r;let n=[];for(let o of e.split(/[,;\n\r]+/)){let i=o.trim();if(!i)continue;let s="",c=/^([A-Za-z]{2})\.(.+)$/.exec(i);if(c&&le(Pe(c[2],443).host)&&(s=c[1].toUpperCase(),i=c[2]),!s){let u=/^(.+)#([A-Za-z]{2})$/.exec(i);u&&(s=u[2].toUpperCase(),i=u[1])}let l=Pe(i,443);if(l.host){if(!s&&!le(l.host)){for(let u of l.host.toUpperCase().split(/[^A-Z0-9]+/))if(/^[A-Z]{2}$/.test(u)&&u!=="IP"&&u!=="CF"){s=u;break}}n.push({host:l.host,port:l.port,cc:s})}}return Ge.size>32&&Ge.clear(),Ge.set(e,n),n},Ur=new Map;async function Rr(t,e){if(e=e||443,le(t))return[{hostname:t,port:e}];let r=t+":"+e,n=Date.now(),o=Ur.get(r);if(o&&n-o.t<3e5)return o.ips;let i=["https://cloudflare-dns.com/dns-query","https://dns.alidns.com/resolve","https://doh.pub/dns-query"],s=async(d,f)=>{for(let x of i)try{let P=await Lr(x+"?name="+encodeURIComponent(t)+"&type="+d,{headers:{accept:"application/dns-json"}},4e3);if(!P||!P.ok)continue;return((await P.json()).Answer||[]).filter(v=>v.type===f).map(v=>v.data)}catch{}return[]},c=await s("TXT",16),l=[];for(let d of c){let f=String(d).replace(/^"|"$/g,"").replace(/\\010/g,",").replace(/\n/g,",").trim();if(!f)continue;if("@"+a("ZWR0dW5uZWw=")===f)break;let x=f.split(/[,;\s]+/).map(v=>v.trim()).filter(Boolean),P=[];for(let v of x){let{host:y,port:w}=Pe(v,e);le(y)&&P.push({hostname:y,port:w})}if(P.length){l=P;break}}l.length||(l=(await s("A",1)).filter(d=>/^\d+\.\d+\.\d+\.\d+$/.test(d)).map(d=>({hostname:d,port:e}))),l.length||(l=(await s("AAAA",28)).filter(d=>le(d)).map(d=>({hostname:d,port:e})));let u=new Set,p=l.filter(d=>{let f=d.hostname+":"+d.port;return!u.has(f)&&(u.add(f),!0)});return p.length&&Ur.set(r,{t:n,ips:p}),p}async function Pt(t){if(!t||!t.length)return null;let e=!1;return await new Promise(r=>{let n=t.length,o=i=>{if(n--,i)if(e)try{i.close()}catch{}else e=!0,r(i);else n<=0&&!e&&r(null)};for(let i of t)Promise.resolve().then(i).then(s=>o(s&&s.readable?s:null),()=>o(null))})}async function Er(t,e,r){let n=null,o=d=>{if(d&&d!==n)try{d.close()}catch{}},i=t?Promise.resolve().then(t).then(d=>d&&d.readable?d:null,()=>null):Promise.resolve(null),s=e&&e.length?Pt(e).then(d=>d&&d.readable?d:null,()=>null):Promise.resolve(null),c=null,l=await Promise.race([i,new Promise(d=>{c=setTimeout(()=>d("__GRACE__"),r)})]);if(c&&(clearTimeout(c),c=null),l&&l!=="__GRACE__")return n=l,s.then(o),n;let u=await s;if(u)return n=u,i.then(o),n;let p=await i;return p?(n=p,n):null}function Bn(t){return!t||t.byteLength<3?"unknown":t[0]===22&&t[1]===3?"tls":"nontls"}async function Jn(t,e,r,n,o){let i=(function(h){if(!h)return null;let m=a("c29ja3M1"),I=String(h).trim(),k=I.match(Ln);if(k&&(m=k[1].toLowerCase(),I=k[2]),m==="ss")return(function(L){let D=L,R="",E=L.indexOf("#");E>=0&&(D=L.slice(0,E));let N=D.lastIndexOf("@");if(N>=0)R=D.slice(0,N),D=D.slice(N+1);else{let z=br(D);if(z&&z.includes("@")){let G=z.lastIndexOf("@");R=z.slice(0,G),D=z.slice(G+1)}}let F="",_="";if(R){let z=br(R)||R;try{z=decodeURIComponent(z)}catch{}let G=z.indexOf(":");G>0?(F=z.slice(0,G),_=z.slice(G+1)):F=z}let{host:re,port:W}=Pe(D,8388);return{type:"ss",host:re,port:W,method:F,password:_}})(I);let g="",A="";if(I.includes("@")){let[L,D]=I.split("@"),R=N=>{try{return decodeURIComponent(N)}catch{return N}},E=L.indexOf(":");E>=0?(g=R(L.slice(0,E)),A=R(L.slice(E+1))):g=R(L),I=D}let V=m==="http"?80:m==="https"?443:1080,{host:M,port:O}=Pe(I,V);return{type:m,host:M,port:O,user:g,pass:A}})(e.outboundProxy),s=e.outboundMode||"",c=o!=="nontls",l=i?i.type==="http"||i.type==="https"?h=>(async function(m,I){let k=await _e(m.host,m.port,6e3),g=k.writable.getWriter(),A=k.readable.getReader(),V="";m.user&&(V=a("UHJveHktQXV0aG9yaXphdGlvbg==")+": Basic "+(function(D){let R="";for(let E=0;E<D.length;E+=32768)R+=String.fromCharCode(...D.subarray(E,E+32768));return btoa(R)})(te.encode(`${m.user}:${m.pass}`))+`\r
`);let M=`${a("Q09OTkVDVA==")} ${I.hostname}:${I.port} HTTP/1.1\r
Host: ${I.hostname}:${I.port}\r
${V}\r
`;await g.write(te.encode(M));let{head:O,leftover:L}=await(async function(D){let R=new Uint8Array(0);for(;R.length<65536;){let{done:E,value:N}=await D.read();if(E)break;R=$(R,N);let F=Yn(R,[13,10,13,10]);if(F>=0)return{head:oe.decode(R.subarray(0,F)),leftover:R.subarray(F+4)}}return{head:oe.decode(R),leftover:new Uint8Array(0)}})(A);if(!/^HTTP\/\d\.\d\s+2\d\d/i.test(O))throw new Error(a("Q09OTkVDVA==")+" \u5931\u8D25: "+O.split(`\r
`)[0]);return L&&L.byteLength>0&&(k._preamble=L),g.releaseLock(),A.releaseLock(),k})(i,h):i.type==="ss"?h=>(async function(m){let I=(function(R){let E=String(R||"").toLowerCase().replace(/_/g,"-");return a("YWVzLTEyOC1nY20=")===E||E==="aes-128gcm"?{name:"AES-GCM",keyLen:16}:a("YWVzLTI1Ni1nY20=")===E||E==="aes-256gcm"?{name:"AES-GCM",keyLen:32}:a("Y2hhY2hhMjA=")+"-ietf-poly1305"===E||a("Y2hhY2hhMjA=")+"-poly1305"===E||a("Y2hhY2hhMjA=")+"poly1305"===E?{name:a("Q0hBQ0hBMjA=")+"-POLY1305",keyLen:32}:null})(m.method);if(!I)throw new Error("\u4E0D\u652F\u6301\u7684 SS \u52A0\u5BC6\u65B9\u5F0F: "+(m.method||"\uFF08\u672A\u6307\u5B9A\uFF09"));if(!m.password)throw new Error("SS \u51FA\u7AD9\u7F3A\u5C11\u5BC6\u7801");let k=await _e(m.host,m.port,6e3),g=k.writable.getWriter(),A=k.readable.getReader(),V=new Uint8Array(0),M=async R=>{for(;V.length<R;){let{done:N,value:F}=await A.read();if(N)throw new Error("SS \u8FDE\u63A5\u88AB\u5173\u95ED");V=$(V,F)}let E=V.slice(0,R);return V=V.subarray(R),E},O=new Uint8Array(await crypto.subtle.digest("SHA-256",te.encode(m.password))),L=crypto.getRandomValues(new Uint8Array(16)),D=await Sr(I.name,await kr(O,L,I.keyLen));return await g.write(L),await g.write(await Cr(D,new Uint8Array(0))),{readable:new ReadableStream({async start(R){try{let E=await M(16),N=await Sr(I.name,await kr(O,E,I.keyLen));for(;;){let F=await N.open(await M(18)),_=F[0]<<8|F[1];if(_>16384)throw new Error("SS \u5206\u7247\u957F\u5EA6\u975E\u6CD5 "+_);let re=await N.open(await M(_+16));_>0&&R.enqueue(re)}}catch(E){try{R.error(E)}catch{}}}}),writable:new WritableStream({async write(R){let E=R instanceof Uint8Array?R:new Uint8Array(R);for(let N=0;N<E.length;N+=16384)await g.write(await Cr(D,E.subarray(N,Math.min(E.length,N+16384))))},close(){try{g.close()}catch{}},abort(){try{g.abort()}catch{}}}),close(){try{k.close()}catch{}}}})(i):h=>(async function(m,I){let k=await _e(m.host,m.port,6e3),g=k.writable.getWriter(),A=k.readable.getReader(),V=new Uint8Array(0),M=async N=>{for(;V.length<N;){let{done:_,value:re}=await A.read();if(_)throw new Error("\u8FDE\u63A5\u88AB\u5173\u95ED");V=$(V,re)}let F=V.slice(0,N);return V=V.subarray(N),F},O=m.user?[5,2,0,2]:[5,1,0];await g.write(new Uint8Array(O));let L=await M(2);if(L[0]!==5||L[1]===255)throw new Error(a("U09DS1M1")+" \u63E1\u624B\u5931\u8D25");if(L[1]===2){if(!m.user)throw new Error(a("U09DS1M1")+" \u670D\u52A1\u5668\u8981\u6C42\u8BA4\u8BC1\u4F46\u672A\u63D0\u4F9B\u51ED\u636E");let N=te.encode(m.user),F=te.encode(m.pass),_=new Uint8Array([1,N.length,...N,F.length,...F]);if(await g.write(_),(await M(2))[1]!==0)throw new Error(a("U09DS1M1")+" \u8BA4\u8BC1\u5931\u8D25")}else if(L[1]!==0)throw new Error(a("U09DS1M1")+" \u4E0D\u652F\u6301\u7684\u8BA4\u8BC1\u65B9\u6CD5 "+L[1]);let D=te.encode(I.hostname),R;R=/^\d+\.\d+\.\d+\.\d+$/.test(I.hostname)?new Uint8Array([5,1,0,1,...I.hostname.split(".").map(Number),I.port>>8&255,255&I.port]):new Uint8Array([5,1,0,3,D.length,...D,I.port>>8&255,255&I.port]),await g.write(R);let E=await M(4);if(E[1]!==0)throw new Error(a("U09DS1M1")+" \u8FDE\u63A5\u5931\u8D25 \u7801"+E[1]);if(E[3]===1)await M(6);else if(E[3]===3){let N=(await M(1))[0];await M(N+2)}else E[3]===4&&await M(18);return V.byteLength>0&&(k._preamble=V),g.releaseLock(),A.releaseLock(),k})(i,h):null,u,p=async h=>{try{let m=await h();if(m)return m}catch(m){u=m}return null},d=()=>{throw u||new Error("\u6240\u6709\u51FA\u7AD9\u65B9\u5F0F\u5747\u5931\u8D25")},f=e.proxyIP?Xn(e.proxyIP):[],x=Tr(r),P=String(r||"").toUpperCase(),v=[];if(f.length&&c){for(let h of f)h.cc&&(h.cc===x||h.cc===P)&&v.push(h);for(let h of f)h.cc||v.push(h);v.length||v.push(f[0]);for(let h of v.slice(0,3)){let m=await p(async()=>{let I=[];try{I=await Rr(h.host,h.port)}catch{}I.length||(I=[{hostname:h.host,port:h.port}]);let k=await Pt(I.slice(0,4).map(g=>()=>p(()=>xt(g,4e3))));if(k)return k});if(m)return m}}let y={hostname:t.addr,port:t.port},w=()=>{if(!c)return[];let h=Tr(r);return[h,...Object.keys(Ar).filter(I=>I!==h)].slice(0,2).map((I,k)=>async()=>{let g=Ar[I];if(!g)return null;let A=[];try{A=await Rr(g,443)}catch{return null}if(!A.length)return null;let V=A.slice(0,k===0?2:1);return await Pt(V.map(M=>()=>p(()=>xt(M,4e3))))})},b=()=>p(()=>xt(y,4e3)),S=l?()=>p(()=>l(y)):null,T=On(t.addr)?0:300,U=()=>Er(b,w().slice(0,3),T);if(s==="only"&&S){let h=await S();return h||await Er(null,w().slice(0,4),0)||d()}if(s===""&&S){let h=await S();return h||await U()||d()}let C=await U();if(C)return C;if(S){let h=await S();if(h)return h}return d()}async function Dr(t,e){let r=new WebSocketPair,[n,o]=Object.values(r);try{o.accept({allowHalfOpen:!0})}catch{o.accept()}o.binaryType="arraybuffer";let i=null,s=null,c=!1,l=null,u=null,p=!1,d=v=>{try{o.send(v)}catch{}},f=async(v,y)=>{if(v&&v.byteLength&&(l=l?$(l,v):v),!l)return;if(l.byteLength>65536)throw new Error("\u63E1\u624B\u5934\u8D85\u8FC7 64KB\uFF0C\u5173\u95ED\u8FDE\u63A5");let w,b;try{let U=(function(C,h){if(!h.enableTrojan||!C||C.byteLength<58)return!1;let m=C.subarray(0,56);if(oe.decode(m).toLowerCase()===xr(h.trojanPassword||h.uuid))return!0;if(C[56]===13&&C[57]===10){for(let I=0;I<56;I++){let k=m[I];if(!(k>=48&&k<=57||k>=97&&k<=102||k>=65&&k<=70))return!1}return!0}return!1})(l,e);if(!U&&l.byteLength>0&&l[0]!==0&&l.byteLength<58)return;b=!U,w=U?(function(C){if(!C||C.byteLength<66)throw new Error(a("VHJvamFu")+" \u5934\u90E8\u8FC7\u77ED");let h=new DataView(C.buffer,C.byteOffset,C.byteLength),m=58,I=h.getUint8(m);m+=1;let k=h.getUint8(m),g,A;if(m+=1,k===1)g=`${h.getUint8(m)}.${h.getUint8(m+1)}.${h.getUint8(m+2)}.${h.getUint8(m+3)}`,A=4;else if(k===3){let M=h.getUint8(m);g=oe.decode(C.subarray(m+1,m+1+M)),A=1+M}else{if(k!==4)throw new Error("\u65E0\u6CD5\u8BC6\u522B\u7684\u5730\u5740\u7C7B\u578B");g=Nr(C.subarray(m,m+16)),A=16}m+=A;let V=h.getUint16(m);return m+=2,m+=2,{command:I,port:V,addr:g,password:oe.decode(C.subarray(0,56)),headerLength:m}})(l):zn(l)}catch(U){if(/头部过短/.test(U.message||""))return;throw U}!p&&b&&w.command!==2&&(p=!0,d(new Uint8Array([0,0])));let S=Bn(l.byteLength>w.headerLength?l.subarray(w.headerLength):null);if(S==="unknown"&&!y)return void(u||(u=setTimeout(()=>{u=null,f(new Uint8Array(0),!0).catch(U=>{try{o.close(1011,String(U&&U.message||U))}catch{}})},80)));if(u&&(clearTimeout(u),u=null),c)return;if(c=!0,w.command===2){try{let U=l.subarray(w.headerLength);if(w.port===53&&U.byteLength>=12){let C=await(async function(h){if(!h||h.byteLength<17)return null;let m=new DataView(h.buffer,h.byteOffset,h.byteLength),I=m.getUint16(0);if(32768&m.getUint16(2)||m.getUint16(4)!==1)return null;let k=12,g=[];for(;k<h.byteLength;){let W=m.getUint8(k);if(W===0){k++;break}if(!(192&~W)){k+=2;break}if(k+1+W>h.byteLength)return null;g.push(oe.decode(h.subarray(k+1,k+1+W))),k+=1+W}if(k+4>h.byteLength||g.length===0)return null;let A=m.getUint16(k),V=m.getUint16(k+2),M=k+4;if(A!==1&&A!==28)return null;let O=g.join("."),L=h.subarray(12,M),D=null;for(let W of _n)try{let z=await Lr(W+"?name="+encodeURIComponent(O)+"&type="+A,{headers:{accept:"application/dns-json"}},5e3);if(!z||!z.ok)continue;let G=await z.json();if(!G||G.Status!==0)continue;let ce=(G.Answer||[]).filter(q=>q.type===A&&(q.type===1?le(String(q.data)):/^[0-9a-fA-F:]+$/.test(String(q.data))));if(ce.length){D=ce;break}}catch{}if(!D)return null;let R=new Uint8Array(12),E=new DataView(R.buffer);E.setUint16(0,I),E.setUint16(2,33152),E.setUint16(4,1),E.setUint16(6,D.length);let N=[R,L];for(let W of D){let z=String(W.data),G=W.type===1?Uint8Array.from(z.split(".").map(Number)):Zn(z);if(G.length!==(W.type===1?4:16))continue;let ce=new Uint8Array(10),q=new DataView(ce.buffer);q.setUint16(0,49164),q.setUint16(2,W.type),q.setUint16(4,V===0?1:V),q.setUint32(6,Number(W.TTL)||300),N.push(ce,new Uint8Array([G.length>>8&255,255&G.length]),G)}let F=0;N.forEach(W=>F+=W.byteLength);let _=new Uint8Array(F),re=0;for(let W of N)_.set(W,re),re+=W.byteLength;return _})(U);C&&d(C)}}catch{}try{o.close(1e3)}catch{}return}let T=await Jn(w,e,t.cf&&t.cf.colo,0,S);i=T,s=T.writable.getWriter(),T._preamble&&T._preamble.byteLength>0&&d(T._preamble),l&&l.byteLength>w.headerLength&&await s.write(l.subarray(w.headerLength)),l=null,(async function(U,C,h){try{for(;;){let{done:m,value:I}=await U.read();if(m)break;C(I)}}catch{}try{h&&h()}catch{}})(T.readable.getReader(),d,()=>{try{o.close(1e3)}catch{}})},x=(function(v,y){if(!v)return null;let w=String(v).trim();if(!w||w.length>8192||!/^[A-Za-z0-9\-_+/=]+$/.test(w))return null;let b=null;try{let S=w.replace(/-/g,"+").replace(/_/g,"/"),T=S.length%4?"=".repeat(4-S.length%4):"",U=atob(S+T);b=new Uint8Array(U.length);for(let C=0;C<U.length;C++)b[C]=U.charCodeAt(C)}catch{return null}if(!b.byteLength||b.byteLength>6144)return null;if(b.byteLength>=17&&b[0]===0){let S=(function(T){let U=String(T||"").replace(/-/g,"");if(U.length!==32)return null;let C=new Uint8Array(16);for(let h=0;h<16;h++){let m=parseInt(U.substr(2*h,2),16);if(isNaN(m))return null;C[h]=m}return C})(y.uuid);if(!S)return b;for(let T=0;T<16;T++)if(b[T+1]!==S[T])return null;return b}return y.enableTrojan&&b.byteLength>=58&&b[56]===13&&b[57]===10&&oe.decode(b.subarray(0,56)).toLowerCase()===xr(y.trojanPassword||y.uuid)?b:null})(t.headers.get("sec-websocket-protocol"),e);x&&f(x).catch(v=>{try{o.close(1011,String(v&&v.message||v))}catch{}}),o.addEventListener("message",async v=>{try{let y=typeof v.data=="string"?te.encode(v.data):new Uint8Array(v.data);c?s?await s.write(y):l=l?$(l,y):y:await f(y)}catch(y){try{o.close(1011,String(y&&y.message||y))}catch{}}});let P=()=>{if(u&&(clearTimeout(u),u=null),i){try{i.close()}catch{}i=null}};return o.addEventListener("close",P),o.addEventListener("error",P),new Response(null,{status:101,webSocket:n})}function Lr(t,e,r){return new Promise(n=>{let o=new AbortController,i=setTimeout(()=>o.abort(),r);fetch(t,Object.assign({},e,{signal:o.signal})).then(s=>{clearTimeout(i),n(s)}).catch(()=>{clearTimeout(i),n(null)})})}var to="https://api."+a("Y2xvdWRmbGFyZWNsaWVudA==")+".com/v0a5641/reg",ro="https://api."+a("Y2xvdWRmbGFyZWNsaWVudA==")+".com/v0a2158/reg",no=a("d3d3Lm1pY3Jvc29mdC5jb20=");var ao=String.raw`
<!DOCTYPE html>
<html lang="zh-CN" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>控制台</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Crect x='3' y='3' width='18' height='18' rx='5' fill='%23f6821f'/%3E%3Cpath d='M8 15V9l8 6V9' stroke='%230d131b' stroke-width='2' fill='none' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E">
<script src="https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.min.js"></script>
<style>
.mark{width:34px;height:34px;border-radius:9px;background:linear-gradient(135deg,var(--accent),var(--accent2));display:flex;align-items:center;justify-content:center;flex:0 0 34px;box-shadow:0 4px 12px var(--accent-dim)}
.mark svg{width:18px;height:18px}
.mark path{stroke:#0d131b}
.ver-chip.has-update{color:var(--accent);background:var(--accent-dim);border-color:var(--accent)}
.ver-chip.checking{opacity:.7;pointer-events:none}
.ibtn{width:34px;height:34px;border-radius:8px;border:1px solid var(--border);background:var(--card);color:var(--text);cursor:pointer;display:flex;align-items:center;justify-content:center;flex:0 0 34px}
.mbadge{margin-left:auto;padding:3px 10px;border-radius:999px;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.06);-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);box-shadow:inset 0 1px 0 rgba(255,255,255,.14);font-size:12px;color:var(--accent);white-space:nowrap}
[data-theme="light"] .mbadge{border-color:rgba(30,45,70,.10);background:rgba(255,255,255,.60);box-shadow:inset 0 1px 0 rgba(255,255,255,.90)}
.ibtn:hover{border-color:var(--accent);color:var(--accent)}
.ibtn svg{width:16px;height:16px;stroke:currentColor}
.wdwarn{display:none;background:rgba(59,130,246,.10);border-bottom:1px solid rgba(59,130,246,.35);color:var(--accent2);padding:9px 26px;font-size:12.5px;line-height:1.6;text-align:center}
[data-theme="light"] .wdwarn{color:var(--accent);background:rgba(29,95,168,.06);border-bottom-color:rgba(29,95,168,.35)}
.content{padding:22px 26px 96px;max-width:1180px;width:100%;margin:0 auto}
@keyframes fade{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
.view-head{margin-bottom:16px}
.view-head h2{font-size:20px;font-weight:700}
.view-head p{color:var(--dim);font-size:13px;margin-top:4px}
.grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(330px,1fr));gap:16px}
.filter-region{display:flex;align-items:center;gap:14px;padding:2px 0 14px;border-bottom:1px solid var(--border);margin-bottom:14px;flex-wrap:wrap}
.filter-region-label{font-size:13px;font-weight:600;white-space:nowrap}
.filter-row{display:flex;flex-wrap:wrap}
.filter-group{flex:0 1 auto;min-width:180px;padding:0 14px;border-left:1px solid var(--border)}
.filter-group:first-child{border-left:none;padding-left:0}
.filter-group-title{font-size:12px;font-weight:600;color:var(--dim);margin-bottom:9px;letter-spacing:.3px}
.pills.nowrap{flex-wrap:nowrap;white-space:nowrap}
.pills.nowrap .spill span{padding:5px 10px;font-size:12px}
.spill input{position:absolute;opacity:0;pointer-events:none}
.spill span{display:inline-block;padding:5px 14px;border:1px solid rgba(255,255,255,.13);border-radius:999px;font-size:12.5px;color:var(--dim);cursor:pointer;background:rgba(255,255,255,.05);-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);box-shadow:inset 0 1px 0 rgba(255,255,255,.14),0 2px 8px rgba(0,0,0,.20);transition:border-color .15s,color .15s,background .15s,box-shadow .15s;user-select:none;line-height:1.5}
.spill:hover span{border-color:var(--accent);color:var(--accent)}
.spill input:checked + span{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:600;border-radius:999px}
.card h3 .tick{width:3px;height:14px;border-radius:2px;background:var(--accent)}
.checkline{display:flex;align-items:center;gap:20px;padding:5px 0;font-size:13px;cursor:pointer}
.checkline input{margin:0;flex:0 0 auto;vertical-align:middle}
.checkline span{line-height:1.5}
.proto-row{display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px dashed var(--border);font-size:13.5px}
.proto-row:last-child{border-bottom:none}
.switch{position:relative;display:inline-block;width:40px;height:22px;flex:0 0 40px}
.switch input{opacity:0;width:0;height:0}
.switch input:checked+.sl{background:var(--accent)}
.switch input:checked+.sl::before{transform:translateX(18px)}
.btn.primary{background:linear-gradient(135deg,var(--accent),var(--accent2));border-color:transparent;color:#201308;font-weight:600}
.btn.primary:hover{filter:brightness(1.06);color:#201308}
.btn.danger{background:var(--err-dim);border-color:transparent;color:var(--err)}
.btn.danger:hover{border-color:var(--err)}
.btn .dirty-dot{display:none;width:6px;height:6px;border-radius:50%;background:var(--warn)}
.btn.dirty .dirty-dot{display:inline-block}
.tbl-wrap{overflow-x:auto}
.badge{display:inline-block;padding:2px 8px;border-radius:10px;font-size:11.5px}
.badge.g{background:var(--ok-dim);color:var(--ok)}
.badge.r{background:var(--err-dim);color:var(--err)}
.msg.show{display:block}
.fbar{position:fixed;right:22px;bottom:22px;display:flex;gap:10px;z-index:60;align-items:center}
.fbar .btn{box-shadow:var(--shadow)}
.saved-at{font-size:11.5px;color:var(--faint);background:var(--card);border:1px solid var(--border);border-radius:8px;padding:5px 10px;box-shadow:var(--shadow);white-space:nowrap}
.toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
.sec-title{font-size:12px;color:var(--faint);letter-spacing:1px;margin:20px 0 10px;font-weight:600}
.danger-zone{border:1px solid var(--err);border-radius:12px;padding:16px;background:var(--err-dim)}
.qrbox{display:flex;justify-content:center;padding:12px 0 4px}
.qrbox img{width:168px;height:168px;image-rendering:pixelated;border-radius:8px}
.note-box{background:var(--card2);border:1px solid var(--border);border-left:3px solid var(--accent);border-radius:8px;padding:12px 14px;font-size:12.5px;color:var(--dim);line-height:1.7;margin-bottom:12px}
@media (min-width:1100px){
  /* 右侧避让右下角浮动保存栏（尚未保存/重置/保存全部），避免遮挡筛选勾选项 */
  .filter-grid{padding-right:200px}
}
.mmode{position:fixed;inset:0;z-index:120;display:none;align-items:center;justify-content:center;padding:18px;background:rgba(4,8,13,.74)}
.mmode.show{display:flex}
.mmodebox{width:100%;max-width:820px;max-height:88vh;overflow-y:auto;background:var(--card);border:1px solid var(--border);border-radius:14px;box-shadow:var(--shadow);padding:22px 22px 16px}
.mmodebox h3{margin:0 0 6px;font-size:17px}
.mmodebox .msub{color:var(--dim);font-size:12.5px;line-height:1.65;margin-bottom:16px}
.mmodegrid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}
.mmodecard{border:1px solid rgba(255,255,255,.14);border-radius:11px;background:rgba(255,255,255,.055);color:var(--text);padding:15px 14px;cursor:pointer;text-align:left;-webkit-backdrop-filter:blur(18px);backdrop-filter:blur(18px);box-shadow:inset 0 1px 0 rgba(255,255,255,.16),0 8px 22px rgba(0,0,0,.30);transition:border-color .15s,transform .15s,box-shadow .15s,background .15s}
.mmodecard:hover{border-color:var(--accent);transform:translateY(-2px)}
.mmodecard b{display:block;font-size:14.5px;margin-bottom:7px}
.mmodecard span{display:block;font-size:12.5px;color:var(--dim);line-height:1.6}
.mmodecard em{display:block;font-style:normal;font-size:11.5px;color:var(--faint);margin-top:9px}
.mmodefoot{margin-top:14px;text-align:right}
.mmodefoot a{color:var(--dim);font-size:12.5px;text-decoration:none}
.mmodefoot a:hover{color:var(--accent)}
@media (max-width:760px){
  .mmodegrid{grid-template-columns:1fr}
}
*{box-sizing:border-box;margin:0;padding:0}:root{--bg:#06080d;--bg2:#090d14;--card:#0c1119;--card2:#101724;--border:#1a2331;--text:#e9eef7;--dim:#93a3b8;--faint:#61718a;--line:#131a25;--accent:#7c6cff;--accent2:#22d3ee;--accent-dim:rgba(124,108,255,.14);--ok:#22c55e;--ok-dim:rgba(34,197,94,.13);--err:#f87171;--err-dim:rgba(248,113,113,.13);--warn:#fbbf24;--sb-bg:#080c12;--sb-text:#9fb0c5;--sb-dim:#5f7292;--sb-border:#161d28;--sb-active-bg:rgba(124,108,255,.14);--sb-active-text:#ab9dff;--sb-active-bar:#7c6cff;--glass:rgba(23,32,45,.54);--glass-2:rgba(19,27,39,.62);--glass-line:rgba(255,255,255,.10);--sb-glass:rgba(20,28,41,.50);--sb-rim:rgba(255,255,255,.46);--sb-vol-a:rgba(255,255,255,.11);--sb-vol-b:rgba(0,0,0,.20);--sb-glass-m:rgba(15,21,32,.88);--glass-rim:rgba(255,255,255,.30);--glass-hi:rgba(255,255,255,.12);--glass-field:rgba(255,255,255,.045);--glass-hover:rgba(255,255,255,.07);--glass-btn:rgba(255,255,255,.09);--glass-btn-hi:rgba(255,255,255,.17);--glass-rim-sm:rgba(255,255,255,.55);--glass-field-brd:rgba(255,255,255,.09);--glass-blur:22px;--glass-sh:0 20px 48px rgba(0,0,0,.42);--glass-shx:12px 0 36px rgba(0,0,0,.30);--blob-o:.44;--shadow:0 14px 40px rgba(0,0,0,.4);color-scheme:dark}[data-theme="light"]{--bg:#f4f6fb;--bg2:#eaeef6;--card:#fff;--card2:#f7f9fd;--border:#e1e7f0;--text:#16202e;--dim:#5a6a80;--faint:#93a1b4;--line:#eaeff6;--accent:#6355f5;--accent2:#0ea5b7;--accent-dim:rgba(99,85,245,.10);--ok:#17915a;--ok-dim:rgba(23,145,90,.11);--err:#dc4c4c;--err-dim:rgba(220,76,76,.10);--warn:#b7791f;--sb-bg:#ffffff;--sb-text:#5a6a80;--sb-dim:#9aa8bb;--sb-border:#e5eaf2;--sb-active-bg:rgba(99,85,245,.10);--sb-active-text:#5546e8;--sb-active-bar:#6355f5;--glass:rgba(255,255,255,.50);--glass-2:rgba(255,255,255,.60);--glass-line:rgba(20,40,70,.10);--sb-glass:rgba(255,255,255,.46);--sb-rim:rgba(255,255,255,1);--sb-vol-a:rgba(255,255,255,.68);--sb-vol-b:rgba(20,40,70,.075);--sb-glass-m:rgba(255,255,255,.90);--glass-rim:rgba(255,255,255,.95);--glass-hi:rgba(255,255,255,.70);--glass-field:rgba(255,255,255,.62);--glass-hover:rgba(20,40,70,.055);--glass-btn:rgba(255,255,255,.86);--glass-btn-hi:#ffffff;--glass-rim-sm:rgba(255,255,255,1);--glass-field-brd:rgba(20,40,70,.11);--glass-blur:22px;--glass-sh:0 18px 44px rgba(25,45,80,.13);--glass-shx:10px 0 30px rgba(25,45,80,.09);--blob-o:.42;--shadow:0 12px 34px rgba(25,40,70,.12);color-scheme:light}html,body{min-height:100%}body{background:var(--bg);color:var(--text);font-family:"PingFang SC","Microsoft YaHei","Segoe UI",system-ui,sans-serif;font-size:14px;line-height:1.6;-webkit-font-smoothing:antialiased}a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}.app{display:flex;min-height:100vh;gap:12px;padding:12px}.sidebar{width:232px;flex:0 0 232px;background:var(--sb-bg);border-right:1px solid var(--sb-border);display:flex;flex-direction:column;position:sticky;top:12px;height:calc(100vh - 24px);z-index:50}.brand{display:flex;align-items:center;gap:11px;padding:18px 18px 14px}.brand .lg{width:34px;height:34px;flex:0 0 34px;border-radius:10px;background:linear-gradient(135deg,var(--accent),var(--accent2));display:flex;align-items:center;justify-content:center;box-shadow:0 4px 12px var(--accent-dim)}.brand .lg svg{width:18px;height:18px;stroke:#0b0e14;fill:none;stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round}.brand .bt{display:flex;flex-direction:column;line-height:1.25;min-width:0}.brand .bt b{font-size:15px;font-weight:700;letter-spacing:.3px}.brand .bt span{font-size:11px;color:var(--sb-dim);white-space:nowrap;over${a("Zmxvdzo=")}hidden;text-over${a("Zmxvdzo=")}ellipsis}.nav{flex:1;padding:6px 10px 12px;overflow-y:auto}.nav-item{display:flex;align-items:center;gap:10px;width:100%;padding:9px 12px;margin:2px 0;border:none;background:transparent;color:var(--sb-text);font-size:13.5px;font-family:inherit;text-align:left;cursor:pointer;border-radius:8px;position:relative;transition:.15s}.nav-item svg{width:17px;height:17px;flex:0 0 17px;stroke:currentColor;fill:none;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}.nav-item:hover{background:var(--sb-active-bg);color:var(--sb-active-text)}.nav-item.on{background:var(--sb-active-bg);color:var(--sb-active-text);font-weight:600}.nav-item.on::before{content:"";position:absolute;left:-10px;top:8px;bottom:8px;width:3px;border-radius:0 3px 3px 0;background:var(--sb-active-bar)}.side-foot{padding:12px 18px;border-top:1px solid var(--sb-border);display:flex;align-items:center;justify-content:space-between;font-size:11.5px;color:var(--sb-dim)}.ver-chip{font-family:ui-monospace,Consolas,monospace;background:var(--accent-dim);color:var(--sb-active-text);padding:2px 8px;border-radius:6px;font-size:11px;border:1px solid transparent}.main{flex:1;min-width:0;display:flex;flex-direction:column;gap:12px}.topbar{display:flex;align-items:center;gap:14px;padding:12px 20px;border:1px solid var(--border);border-radius:18px;background:var(--bg);position:sticky;top:12px;z-index:40}.topbar h1{font-size:17px;font-weight:600;flex:1;min-width:0}.ibtn.hamb{display:none}.pill{display:inline-flex;align-items:center;gap:6px;font-size:12px;padding:4px 11px;border-radius:20px;background:var(--ok-dim);color:var(--ok);white-space:nowrap}.pill.off{background:var(--err-dim);color:var(--err)}.pill i{width:6px;height:6px;border-radius:50%;background:currentColor;display:block}.ibtn{width:34px;height:34px;border-radius:9px;border:1px solid var(--border);background:var(--card2);color:var(--dim);cursor:pointer;display:flex;align-items:center;justify-content:center}.ibtn:hover{border-color:var(--accent);color:var(--accent)}.ibtn svg{width:16px;height:16px;stroke:currentColor;fill:none;stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round}.wrap{width:100%;max-width:1180px;margin:0 auto;padding:0 4px 96px}.view{display:none}.view.on{display:block;animation:up .2s ease}@keyframes up{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}.vh{margin-bottom:16px}.vh h2{font-size:20px;font-weight:700}.vh p{color:var(--dim);font-size:13px;margin-top:3px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(330px,1fr));gap:16px}.grid3{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:16px}.card{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:18px;margin-bottom:16px}.card h3{font-size:14px;font-weight:650;margin-bottom:14px;display:flex;align-items:center;gap:9px}.card h3 .dot{width:4px;height:15px;border-radius:3px;background:linear-gradient(var(--accent),var(--accent2))}.card h3 .sub{font-size:12px;color:var(--dim);font-weight:400;margin-left:auto}.kv{display:flex;justify-content:space-between;gap:12px;padding:8px 0;border-bottom:1px dashed var(--line);font-size:13px}.kv:last-child{border-bottom:none}.kv .k{color:var(--dim);white-space:nowrap}.kv .v{text-align:right;word-break:break-all;font-family:ui-monospace,Consolas,monospace;font-size:12.5px}.kv .v.ok{color:var(--ok)}.kv .v.bad{color:var(--err)}.kv .v.warn{color:var(--warn)}.field{margin-bottom:13px}.field>label{display:block;font-size:12.5px;color:var(--dim);margin-bottom:6px;font-weight:500}input[type=text],input[type=password],input[type=number],select,textarea{width:100%;background:var(--card2);border:1px solid var(--border);color:var(--text);border-radius:9px;padding:9px 11px;font-size:13.5px;outline:none;font-family:inherit;transition:.15s}input:focus,select:focus,textarea:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-dim)}textarea{resize:vertical;line-height:1.55;font-family:ui-monospace,Consolas,monospace;font-size:12.5px}select{cursor:pointer;appearance:none;-webkit-appearance:none;padding-right:30px;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%2393a3b8' stroke-width='1.6' fill='none' stroke-linecap='round'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 11px center}select option,select optgroup{background:var(--bg2);color:var(--text)}input,select,textarea{accent-color:var(--accent)}.hint{font-size:12px;color:var(--dim);margin-top:7px;line-height:1.7}.inrow{display:flex;gap:8px;align-items:flex-start}.inrow>div{flex:1}.sw{position:relative;display:inline-block;width:40px;height:22px;flex:0 0 40px}.sw input{opacity:0;width:0;height:0}.sw .sl{position:absolute;inset:0;background:var(--border);border-radius:22px;cursor:pointer;transition:.18s}.sw .sl::before{content:"";position:absolute;width:16px;height:16px;left:3px;top:3px;background:#fff;border-radius:50%;transition:transform .18s}.sw input:checked+.sl{background:var(--accent)}.sw input:checked+.sl::before{transform:translateX(18px)}.prow{display:flex;align-items:center;gap:11px;padding:9px 0;border-bottom:1px dashed var(--line);font-size:13.5px}.prow:last-child{border-bottom:none}.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;border:1px solid var(--border);background:var(--card2);color:var(--text);border-radius:9px;padding:9px 15px;font-size:13px;cursor:pointer;font-family:inherit;white-space:nowrap;transition:.15s}.btn:hover{border-color:var(--accent);color:var(--accent)}.btn:active{transform:translateY(1px)}.btn:disabled{opacity:.5;cursor:not-allowed}.btn.pri{background:linear-gradient(135deg,var(--accent),var(--accent2));border-color:transparent;color:#0b0e14;font-weight:600}.btn.pri:hover{filter:brightness(1.07);color:#0b0e14}.btn.dgr{background:var(--err-dim);border-color:transparent;color:var(--err)}.btn.sm{padding:5px 11px;font-size:12px;border-radius:7px}.row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.row .grow{flex:1;min-width:150px}.pills{display:flex;flex-wrap:wrap;gap:8px}.sp{position:relative}.sp input{position:absolute;opacity:0;pointer-events:none}.sp span{display:inline-block;padding:5px 13px;border:1px solid var(--border);border-radius:999px;font-size:12.5px;color:var(--dim);cursor:pointer;background:var(--card2);transition:.15s;user-select:none}.sp:hover span{border-color:var(--accent);color:var(--accent)}.sp input:checked+span{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:600}.blk{border-top:1px solid var(--line);margin-top:14px;padding-top:14px}.blk-t{font-size:12px;font-weight:600;color:var(--dim);margin-bottom:10px;letter-spacing:.4px}.tbl{overflow-x:auto}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:9px 10px;font-size:13px;border-bottom:1px solid var(--line);white-space:nowrap}th{color:var(--dim);font-weight:500;font-size:12px;background:var(--card2)}td.ip{font-family:ui-monospace,Consolas,monospace;font-size:12.5px}.bdg{display:inline-block;padding:2px 9px;border-radius:10px;font-size:11.5px}.bdg.g{background:var(--ok-dim);color:var(--ok)}.bdg.r{background:var(--err-dim);color:var(--err)}.mono{font-family:ui-monospace,Consolas,monospace;font-size:12.5px}.msg{display:none;margin-top:12px;padding:10px 13px;border-radius:9px;font-size:12.5px;line-height:1.65}.msg.on{display:block}.msg.ok{background:var(--ok-dim);color:var(--ok)}.msg.err{background:var(--err-dim);color:var(--err)}.msg.info{background:var(--accent-dim);color:var(--accent)}pre.code{background:var(--bg2);border:1px solid var(--border);border-radius:9px;padding:12px;font-size:11.5px;line-height:1.55;font-family:ui-monospace,Consolas,monospace;over${a("Zmxvdzo=")}auto;max-height:280px;white-space:pre-wrap;word-break:break-all;color:var(--dim);margin-top:10px}.bar{position:fixed;right:20px;bottom:20px;display:flex;gap:10px;align-items:center;z-index:60}.bar .btn{box-shadow:var(--shadow)}.stat{font-size:11.5px;color:var(--faint);background:var(--card);border:1px solid var(--border);border-radius:9px;padding:6px 11px;box-shadow:var(--shadow);white-space:nowrap}.toast{position:fixed;left:50%;bottom:26px;transform:translateX(-50%) translateY(90px);background:var(--card);border:1px solid var(--border);padding:11px 20px;border-radius:11px;font-size:13px;opacity:0;transition:.25s;z-index:200;box-shadow:var(--shadow);pointer-events:none;max-width:86vw}.toast.on{opacity:1;transform:translateX(-50%) translateY(0)}.toast.ok{border-color:var(--ok);color:var(--ok)}.toast.err{border-color:var(--err);color:var(--err)}.toast.warn{border-color:var(--warn);color:var(--warn)}.note{background:var(--card2);border:1px solid var(--border);border-left:3px solid var(--accent);border-radius:9px;padding:12px 14px;font-size:12.5px;color:var(--dim);line-height:1.75}.steps{list-style:none;counter-reset:st}.steps li{counter-increment:st;position:relative;padding:0 0 15px 32px;font-size:13px;color:var(--dim)}.steps li::before{content:counter(st);position:absolute;left:0;top:1px;width:22px;height:22px;border-radius:50%;background:var(--accent-dim);color:var(--accent);display:flex;align-items:center;justify-content:center;font-size:11.5px;font-weight:700}.steps li b{color:var(--text)}.prog{height:9px;border-radius:7px;background:var(--card2);over${a("Zmxvdzo=")}hidden;margin:10px 0}.prog>div{height:100%;width:0;border-radius:7px;background:linear-gradient(90deg,var(--ok),var(--accent));transition:width .5s}.qr{display:flex;justify-content:center;padding:12px 0 2px}.qr img{width:170px;height:170px;image-rendering:pixelated;border-radius:10px;background:#fff;padding:8px}.dz{border:1px solid var(--err);border-radius:14px;padding:16px;background:var(--err-dim);margin-bottom:16px}.dz h3{font-size:14px;color:var(--err);margin-bottom:8px}.fgrp{border:1px solid var(--border);border-radius:11px;padding:12px;margin-bottom:12px}.fgrp-t{font-size:12px;font-weight:600;color:var(--dim);margin-bottom:9px}.bgfx{position:fixed;inset:0;z-index:0;over${a("Zmxvdzo=")}hidden;pointer-events:none}.bgfx i{position:absolute;display:block;border-radius:50%;filter:blur(74px);opacity:var(--blob-o);will-change:transform}.bgfx i:nth-child(1){width:46vw;height:46vw;left:-12vw;top:-16vh;background:var(--accent);animation:blob 24s ease-in-out infinite}.bgfx i:nth-child(2){width:38vw;height:38vw;right:-14vw;top:2vh;background:var(--accent2);opacity:calc(var(--blob-o) * .72);animation:blob 30s ease-in-out infinite -8s}.bgfx i:nth-child(3){width:34vw;height:34vw;left:20vw;bottom:-22vh;background:#f472b6;opacity:calc(var(--blob-o) * .55);animation:blob 27s ease-in-out infinite -14s}.bgfx i:nth-child(4){width:30vw;height:30vw;right:10vw;bottom:-16vh;background:#38bdf8;opacity:calc(var(--blob-o) * .5);animation:blob 33s ease-in-out infinite -20s}@keyframes blob{0%,100%{transform:translate3d(0,0,0) scale(1)}33%{transform:translate3d(4vw,4vh,0) scale(1.1)}66%{transform:translate3d(-3vw,2vh,0) scale(.94)}}.app{position:relative;z-index:1}.sidebar{background:var(--sb-glass);-webkit-backdrop-filter:blur(30px) saturate(190%);backdrop-filter:blur(30px) saturate(190%);border:1px solid var(--glass-line);border-radius:22px;corner-shape:squircle;isolation:isolate;box-shadow:var(--glass-sh),inset 0 1px 0 var(--glass-hi),0 0 0 1px rgba(255,255,255,.03)}.sidebar::before{content:"";position:absolute;inset:0;border-radius:inherit;pointer-events:none;z-index:0;background:radial-gradient(520px 400px at var(--mx,50%) var(--my,-16%),var(--glass-hi),transparent 62%),linear-gradient(180deg,var(--sb-vol-a) 0,rgba(0,0,0,0) 32%,rgba(0,0,0,0) 60%,var(--sb-vol-b) 100%)}.sidebar::after{content:"";position:absolute;inset:0;border-radius:inherit;padding:1px;pointer-events:none;z-index:1;background:linear-gradient(150deg,var(--sb-rim) 0,rgba(255,255,255,0) 34%,rgba(255,255,255,0) 66%,var(--sb-rim) 100%);-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);mask-composite:exclude}.sidebar>*{position:relative;z-index:2}.side-foot{border-top:1px solid var(--glass-line)}.nav::-webkit-scrollbar{width:8px}.nav::-webkit-scrollbar-thumb{background:var(--glass-field-brd);border-radius:8px}.nav-item{border-radius:12px}.nav-item:hover{background:var(--glass-hover)}.nav-item.on{background:var(--sb-active-bg);box-shadow:inset 0 1px 0 var(--glass-hi),0 6px 18px rgba(0,0,0,.16)}.topbar{background:var(--glass-2);-webkit-backdrop-filter:blur(20px) saturate(180%);backdrop-filter:blur(20px) saturate(180%);border:1px solid var(--glass-line);box-shadow:var(--glass-sh),inset 0 1px 0 var(--glass-hi)}.topbar::after{content:"";position:absolute;inset:0;border-radius:inherit;padding:1px;pointer-events:none;background:linear-gradient(150deg,var(--glass-rim) 0,rgba(255,255,255,0) 36%,rgba(255,255,255,0) 64%,var(--glass-rim) 100%);-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);mask-composite:exclude}.ibtn{position:relative;background:var(--glass-field);border:1px solid var(--glass-field-brd);border-radius:11px;box-shadow:inset 0 1px 0 var(--glass-hi);transition:.18s cubic-bezier(.34,1.4,.64,1)}.ibtn:hover{background:var(--glass);border-color:var(--glass-rim);color:var(--accent);transform:translateY(-1px)}.ibtn:active{transform:translateY(0) scale(.96)}.card{position:relative;background:var(--glass);-webkit-backdrop-filter:blur(var(--glass-blur)) saturate(170%);backdrop-filter:blur(var(--glass-blur)) saturate(170%);border:1px solid var(--glass-line);border-radius:20px;corner-shape:squircle;box-shadow:var(--glass-sh),inset 0 1px 0 var(--glass-hi)}.card>*{position:relative;z-index:1}.card::before{content:"";position:absolute;inset:0;border-radius:inherit;pointer-events:none;z-index:0;background:radial-gradient(440px 260px at var(--mx,50%) var(--my,-12%),var(--glass-hi),transparent 68%)}.card::after{content:"";position:absolute;inset:0;border-radius:inherit;padding:1px;pointer-events:none;z-index:0;background:linear-gradient(150deg,var(--glass-rim) 0,rgba(255,255,255,0) 32%,rgba(255,255,255,0) 64%,var(--glass-rim) 100%);-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);mask-composite:exclude}.fgrp{background:var(--glass-field);border:1px solid var(--glass-field-brd);border-radius:14px;corner-shape:squircle}.note{background:var(--glass-field);border:1px solid var(--glass-field-brd);border-left:3px solid var(--accent);border-radius:14px}pre.code{background:var(--glass-field);border:1px solid var(--glass-field-brd);border-radius:14px}.msg{border-radius:13px}input[type=text],input[type=password],input[type=number],select,textarea{background:var(--glass-field);border:1px solid var(--glass-field-brd);border-radius:12px;box-shadow:inset 0 1px 0 var(--glass-hi)}.sp span{background:var(--glass-field);border:1px solid var(--glass-field-brd)}th{background:var(--glass-field)}.btn{background:var(--glass-field);border:1px solid var(--glass-field-brd);border-radius:13px;position:relative;box-shadow:inset 0 1px 0 var(--glass-hi),0 4px 14px rgba(0,0,0,.16);transition:.18s cubic-bezier(.34,1.4,.64,1)}.btn:hover{background:var(--glass);border-color:var(--glass-rim);color:var(--text);transform:translateY(-1px)}.btn:active{transform:translateY(0) scale(.985)}.btn.sm{border-radius:10px}.btn.pri{background:linear-gradient(135deg,var(--accent),var(--accent2));border-color:transparent;color:#0b0e14;box-shadow:0 8px 24px var(--accent-dim),inset 0 1px 0 rgba(255,255,255,.45);over${a("Zmxvdzo=")}hidden}.btn.pri:hover{color:#0b0e14;filter:brightness(1.06)}.btn.pri::after{content:"";position:absolute;top:-60%;left:-40%;width:36%;height:220%;pointer-events:none;transform:rotate(16deg);background:linear-gradient(90deg,rgba(255,255,255,0),rgba(255,255,255,.6),rgba(255,255,255,0));opacity:0;transition:opacity .2s}.btn.pri:hover::after{opacity:1;animation:sheen .85s cubic-bezier(.4,0,.2,1)}@keyframes sheen{from{left:-40%}to{left:130%}}.bar .stat{background:var(--glass);-webkit-backdrop-filter:blur(18px) saturate(180%);backdrop-filter:blur(18px) saturate(180%);border:1px solid var(--glass-line);border-radius:14px;box-shadow:var(--glass-sh)}.toast{background:var(--glass);-webkit-backdrop-filter:blur(24px) saturate(180%);backdrop-filter:blur(24px) saturate(180%);border:1px solid var(--glass-line);border-radius:16px;box-shadow:var(--glass-sh)}.pill{box-shadow:inset 0 1px 0 rgba(255,255,255,.18)}.btn::before,.ibtn::before,.sp span::before,.pill::before,.nav-item.on::after{content:"";position:absolute;inset:0;border-radius:inherit;padding:1px;pointer-events:none;background:linear-gradient(160deg,var(--glass-rim-sm) 0,rgba(255,255,255,0) 42%,rgba(255,255,255,0) 58%,var(--glass-rim-sm) 100%);-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);mask-composite:exclude}.btn{background:var(--glass-btn);border-radius:13px;box-shadow:inset 0 1px 0 var(--glass-hi),0 6px 18px rgba(0,0,0,.20),0 1px 2px rgba(0,0,0,.18)}.btn:hover{background:var(--glass-btn-hi);border-color:var(--glass-rim-sm);color:var(--text);transform:translateY(-1px);box-shadow:inset 0 1px 0 var(--glass-hi),0 10px 26px rgba(0,0,0,.26)}.bar .btn{box-shadow:inset 0 1px 0 var(--glass-hi),var(--glass-sh)}.ibtn{background:var(--glass-btn);box-shadow:inset 0 1px 0 var(--glass-hi),0 4px 12px rgba(0,0,0,.16)}.ibtn:hover{background:var(--glass-btn-hi)}.sp span{position:relative;background:var(--glass-btn);box-shadow:inset 0 1px 0 var(--glass-hi)}.sp input:checked+span{box-shadow:inset 0 1px 0 rgba(255,255,255,.35),0 4px 14px var(--accent-dim)}.pill{position:relative;box-shadow:inset 0 1px 0 rgba(255,255,255,.22)}.ver-chip{position:relative;box-shadow:inset 0 1px 0 rgba(255,255,255,.20)}.nav-item{border-radius:12px}.nav-item.on{background:linear-gradient(180deg,rgba(255,255,255,.10),rgba(255,255,255,0)),var(--sb-active-bg);box-shadow:inset 0 1px 0 var(--glass-hi),0 8px 20px rgba(0,0,0,.18)}.sw .sl{background:var(--glass-field);border:1px solid var(--glass-field-brd);box-shadow:inset 0 1px 2px rgba(0,0,0,.16)}.sw input:checked+.sl{background:linear-gradient(135deg,var(--accent),var(--accent2));border-color:transparent;box-shadow:inset 0 1px 0 rgba(255,255,255,.40),0 2px 10px var(--accent-dim)}.sw .sl::before{box-shadow:0 1px 4px rgba(0,0,0,.40)}.bdg{box-shadow:inset 0 1px 0 rgba(255,255,255,.20)}.fgrp,.note,pre.code{box-shadow:inset 0 1px 0 var(--glass-hi)}.msg{box-shadow:inset 0 1px 0 rgba(255,255,255,.14)}.prog{background:var(--glass-field);border:1px solid var(--glass-field-brd);box-shadow:inset 0 1px 2px rgba(0,0,0,.14)}.steps li::before{background:var(--accent-dim);box-shadow:inset 0 1px 0 rgba(255,255,255,.22)}.dz{background:var(--err-dim);border:1px solid rgba(248,113,113,.30);border-radius:18px;-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);box-shadow:var(--glass-sh)}@supports not ((backdrop-filter:blur(1px)) or (-webkit-backdrop-filter:blur(1px))){.sidebar,.topbar{background:var(--card2)}.card{background:var(--card)}.btn,.ibtn,.sp span{background:var(--card2)}.bar .stat,.toast{background:var(--card)}}@media(prefers-reduced-motion:reduce){.bgfx i{animation:none}.btn.pri:hover::after{animation:none;opacity:0}.ibtn:hover,.btn:hover{transform:none}.view.on{animation:none}}@media(max-width:640px){:root{--glass-blur:14px}.sidebar{-webkit-backdrop-filter:blur(18px) saturate(180%);backdrop-filter:blur(18px) saturate(180%)}.bgfx i:nth-child(3),.bgfx i:nth-child(4){display:none}}@media(max-width:960px){.sidebar{position:fixed;left:12px;top:12px;height:calc(100vh - 24px);background:var(--sb-glass-m);transform:translateX(calc(-100% - 28px));transition:transform .22s ease;z-index:70;box-shadow:var(--glass-sh),inset 0 1px 0 var(--glass-hi)}.sidebar.open{transform:translateX(0)}.ibtn.hamb{display:flex}.app{padding:10px;gap:10px}.wrap{padding:0 2px 92px}.topbar{padding:10px 14px;top:10px}}@media(max-width:560px){.topbar .pill{display:none}}[data-style="material"]{--bg:var(--m-surface);--bg2:var(--m-surface-container);--card:var(--m-surface-container-low);--card2:var(--m-surface-container);--border:var(--m-outline-variant);--line:var(--m-outline-variant);--text:var(--m-on-surface);--dim:var(--m-on-surface-variant);--faint:var(--m-outline);--accent:var(--m-primary);--accent2:var(--m-tertiary);--accent-dim:var(--m-primary-container);--ok:var(--m-primary);--ok-dim:var(--m-primary-container);--err:var(--m-error);--err-dim:var(--m-error-container);--warn:var(--m-tertiary);--glass-rim:transparent;--glass-rim-sm:transparent;--glass-hi:transparent;--sb-rim:transparent;--sb-vol-a:transparent;--sb-vol-b:transparent;--m-e1:0 1px 2px rgba(0,0,0,.42),0 1px 3px 1px rgba(0,0,0,.24);--m-e2:0 1px 2px rgba(0,0,0,.42),0 2px 6px 2px rgba(0,0,0,.24);--m-e3:0 1px 3px rgba(0,0,0,.42),0 4px 8px 3px rgba(0,0,0,.24);--shadow:var(--m-e2);font-family:Roboto,"Roboto Flex","Noto Sans SC","PingFang SC","Microsoft YaHei",system-ui,sans-serif}[data-theme="light"][data-style="material"]{--m-e1:0 1px 2px rgba(0,0,0,.16),0 1px 3px 1px rgba(0,0,0,.09);--m-e2:0 1px 2px rgba(0,0,0,.16),0 2px 6px 2px rgba(0,0,0,.09);--m-e3:0 1px 3px rgba(0,0,0,.16),0 4px 8px 3px rgba(0,0,0,.09)}[data-style="material"] .bgfx{display:none}[data-style="material"] .card::before,[data-style="material"] .card::after,[data-style="material"] .sidebar::before,[data-style="material"] .sidebar::after,[data-style="material"] .topbar::after{display:none}[data-style="material"] .sidebar{background:var(--m-surface-container-low);-webkit-backdrop-filter:none;backdrop-filter:none;border:none;border-radius:16px;box-shadow:var(--m-e1)}[data-style="material"] .brand .lg{border-radius:12px;box-shadow:none}[data-style="material"] .brand .bt b{font-weight:500}[data-style="material"] .nav-item{border-radius:28px;padding:10px 16px;font-size:14px}[data-style="material"] .nav-item.on::before{display:none}[data-style="material"] .nav-item.on{background:var(--m-secondary-container);color:var(--m-on-secondary-container);font-weight:500;box-shadow:none}[data-style="material"] .nav-item:hover{background:transparent;color:var(--text)}[data-style="material"] .side-foot{border-top:1px solid var(--m-outline-variant)}[data-style="material"] .ver-chip{background:var(--m-secondary-container);color:var(--m-on-secondary-container);border-radius:8px;box-shadow:none}[data-style="material"] .topbar{background:var(--m-surface);-webkit-backdrop-filter:none;backdrop-filter:none;border:none;border-radius:16px;box-shadow:none}[data-style="material"] .topbar h1{font-weight:400;font-size:20px}[data-style="material"] .ibtn{background:transparent;border:none;border-radius:50%;color:var(--m-on-surface-variant);box-shadow:none;over${a("Zmxvdzo=")}hidden}[data-style="material"] .ibtn:hover{background:transparent;color:var(--m-on-surface)}[data-style="material"] .ibtn:active{transform:none}[data-style="material"] .pill{background:var(--m-secondary-container);color:var(--m-on-secondary-container);border-radius:8px;box-shadow:none;padding:5px 12px;font-weight:500}[data-style="material"] .card{background:var(--m-surface-container-low);border:none;border-radius:16px;box-shadow:var(--m-e1);-webkit-backdrop-filter:none;backdrop-filter:none}[data-style="material"] .card h3{font-weight:500}[data-style="material"] .card h3 .dot{background:var(--m-primary)}[data-style="material"] .fgrp,[data-style="material"] .note,[data-style="material"] pre.code{background:var(--m-surface-container);border:1px solid var(--m-outline-variant);border-radius:12px;box-shadow:none}[data-style="material"] .note{border-left:1px solid var(--m-outline-variant)}[data-style="material"] .msg{border-radius:12px;box-shadow:none}[data-style="material"] input[type=text],[data-style="material"] input[type=password],[data-style="material"] input[type=number],[data-style="material"] select,[data-style="material"] textarea{background:transparent;border:1px solid var(--m-outline);border-radius:8px;box-shadow:none}[data-style="material"] input:focus,[data-style="material"] select:focus,[data-style="material"] textarea:focus{border-color:var(--m-primary);box-shadow:inset 0 0 0 1px var(--m-primary)}[data-style="material"] th{background:var(--m-surface-container);font-weight:500}[data-style="material"] .bdg{box-shadow:none;background:var(--m-secondary-container);color:var(--m-on-secondary-container)}[data-style="material"] .box{background:var(--m-surface-container-high);border:none;border-radius:28px;-webkit-backdrop-filter:none;backdrop-filter:none;box-shadow:var(--m-e3);corner-shape:round}[data-style="material"] .box::after{display:none}[data-style="material"] .logo{background:var(--m-primary-container);border-radius:16px;box-shadow:none}[data-style="material"] .logo svg{stroke:var(--m-on-primary-container)}[data-style="material"] .box p{color:var(--m-on-surface-variant)}[data-style="material"] .btn{background:var(--m-secondary-container);color:var(--m-on-secondary-container);border:none;border-radius:20px;box-shadow:none;font-weight:500;-webkit-mask:none;over${a("Zmxvdzo=")}hidden}[data-style="material"] .btn:hover{background:var(--m-secondary-container);color:var(--m-on-secondary-container);transform:none;box-shadow:var(--m-e1)}[data-style="material"] .btn:active{transform:none}[data-style="material"] .btn.pri{background:var(--m-primary);color:var(--m-on-primary);box-shadow:none;border-radius:20px}[data-style="material"] .btn.pri:hover{background:var(--m-primary);color:var(--m-on-primary);box-shadow:var(--m-e1);filter:none}[data-style="material"] .btn.pri::after{display:none}[data-style="material"] .btn.sm{border-radius:18px}[data-style="material"] .btn.dgr{background:var(--m-error);color:var(--m-on-error)}[data-style="material"] .sp span{background:transparent;border:1px solid var(--m-outline);color:var(--m-on-surface-variant);border-radius:20px;box-shadow:none}[data-style="material"] .sp input:checked+span{background:var(--m-secondary-container);color:var(--m-on-secondary-container);border-color:transparent;box-shadow:none}[data-style="material"] .btn::before,[data-style="material"] .ibtn::before,[data-style="material"] .sp span::before,[data-style="material"] .nav-item::before{content:"";position:absolute;inset:0;border-radius:inherit;background:currentColor;opacity:0;-webkit-mask:none;mask:none;pointer-events:none;transition:opacity .12s}[data-style="material"] .btn:hover::before,[data-style="material"] .ibtn:hover::before,[data-style="material"] .sp span:hover::before,[data-style="material"] .nav-item:hover::before{opacity:.08}[data-style="material"] .btn:active::before,[data-style="material"] .ibtn:active::before,[data-style="material"] .sp span:active::before{opacity:.12}[data-style="material"] .card,.md-rip-host{position:relative}[data-style="material"] .nav-item,[data-style="material"] .sp span,[data-style="material"] .pill,[data-style="material"] .fgrp{position:relative;over${a("Zmxvdzo=")}hidden}.md-rip{position:absolute;border-radius:50%;pointer-events:none;background:currentColor;opacity:0;transform:scale(0);animation:mdRip .62s cubic-bezier(.2,0,0,1) forwards}@keyframes mdRip{0%{opacity:.20;transform:scale(.25)}55%{opacity:.14}100%{opacity:0;transform:scale(1)}}@media(prefers-reduced-motion:reduce){.md-rip{display:none}}[data-style="material"] .sw .sl{background:var(--m-surface-container-highest);border:1px solid var(--m-outline);box-shadow:none}[data-style="material"] .sw input:checked+.sl{background:var(--m-primary);border-color:var(--m-primary);box-shadow:none}[data-style="material"] .sw .sl::before{box-shadow:0 1px 3px rgba(0,0,0,.30)}[data-style="material"] .prog{background:var(--m-surface-container-highest);border:none;border-radius:4px;box-shadow:none;height:8px}[data-style="material"] .prog>div{border-radius:4px;background:var(--m-primary)}[data-style="material"] .steps li::before{background:var(--m-primary-container);color:var(--m-on-primary-container);box-shadow:none}[data-style="material"] .dz{background:var(--m-error-container);border:none;border-radius:16px;-webkit-backdrop-filter:none;backdrop-filter:none;box-shadow:none}[data-style="material"] .dz h3{color:var(--m-on-error-container)}[data-style="material"] .dz p{color:var(--m-on-error-container)}[data-style="material"] .bar .stat,[data-style="material"] .toast{background:var(--m-surface-container-high);-webkit-backdrop-filter:none;backdrop-filter:none;border:none;border-radius:12px;box-shadow:var(--m-e3);color:var(--text)}[data-style="material"] .bar .btn{box-shadow:var(--m-e2)}[data-style="material"] .qr img{border-radius:12px}.seg{display:flex;gap:8px;flex-wrap:wrap}.seg button{flex:1;min-width:120px;justify-content:center}.seg button.on{background:var(--accent);color:#fff;border-color:transparent}[data-style="material"] .seg button.on{background:var(--m-primary);color:var(--m-on-primary)}.md-sw{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}.md-sw i{width:30px;height:30px;border-radius:50%;cursor:pointer;display:block;box-shadow:0 0 0 1px var(--border);transition:transform .15s}.md-sw i:hover{transform:scale(1.1)}.md-sw i.on{box-shadow:0 0 0 2px var(--accent),0 0 0 4px var(--bg2)}.md-pal{margin-top:14px;border:1px solid var(--border);border-radius:12px;over${a("Zmxvdzo=")}hidden}.md-pal .r{display:flex;align-items:center;gap:2px;padding:3px 6px}.md-pal .r b{width:66px;flex:0 0 66px;font-size:10.5px;font-weight:500;color:var(--dim);font-family:ui-monospace,Consolas,monospace}.md-pal .r i{flex:1;height:20px;border-radius:4px;display:block;cursor:pointer;position:relative;z-index:0;transition:transform .12s ease,box-shadow .12s ease}.md-pal .r:hover b{color:var(--text)}.md-pal .r i:hover{transform:scale(1.16);z-index:3;box-shadow:0 0 0 1.5px var(--text),0 4px 10px rgba(0,0,0,.45)}.md-pal .r i.on{z-index:2;box-shadow:inset 0 0 0 2px rgba(255,255,255,.94),inset 0 0 0 4px rgba(0,0,0,.56)}.md-pal .r:first-child i{border-radius:6px 6px 4px 4px}.md-pal .r:last-child i{border-radius:4px 4px 6px 6px}.md-out{display:flex;align-items:center;gap:9px;margin-top:10px;flex-wrap:wrap;font-size:12px}.md-out .chip{width:20px;height:20px;border-radius:6px;flex:0 0 20px;display:block;box-shadow:0 0 0 1px var(--border)}.md-out .hx{font-family:ui-monospace,Consolas,monospace;color:var(--text);cursor:pointer;letter-spacing:.4px;padding:3px 7px;border-radius:7px;background:var(--bg2);box-shadow:0 0 0 1px var(--border)}.md-out .hx:hover{background:var(--card2)}.md-out .tag{color:var(--faint)}.md-seed{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}.md-seed i{width:34px;height:34px;border-radius:9px;cursor:pointer;display:block;box-shadow:0 0 0 1px var(--border);transition:transform .15s}.md-seed i:hover{transform:scale(1.08)}.md-seed i.on{box-shadow:0 0 0 2px var(--accent),0 0 0 4px var(--bg2)}

/* ===== ${a("Q0ZOZXh0")} 自有组件层：对齐参考面板视觉 ===== */
.view-head{margin-bottom:16px}
.view-head h2{font-size:20px;font-weight:700}
.view-head p{color:var(--dim);font-size:13px;margin-top:4px}
.mark{width:34px;height:34px;flex:0 0 34px;border-radius:10px;background:linear-gradient(135deg,var(--accent),var(--accent2));display:flex;align-items:center;justify-content:center;box-shadow:0 4px 12px var(--accent-dim)}
.mark svg{width:19px;height:19px}
.mark path{stroke:#fff}
.fold{display:none}
.fold.open{display:block}
.foldbtn{margin-left:auto;flex:0 0 26px;width:26px;height:26px;padding:0;border:1px solid var(--border);border-radius:8px;background:var(--card2);color:var(--dim);display:flex;align-items:center;justify-content:center;cursor:pointer;transition:color .18s,border-color .18s,background .18s}
.foldbtn:hover{color:var(--text);border-color:var(--accent);background:var(--accent-dim)}
.foldbtn svg{width:14px;height:14px;transition:transform .2s ease}
.foldbtn[data-open="1"] svg{transform:rotate(180deg)}
.foldbtn path{fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.card h3 .tick{width:4px;height:15px;border-radius:3px;background:linear-gradient(var(--accent),var(--accent2))}
.btn.primary{background:linear-gradient(135deg,var(--accent),var(--accent2));border-color:transparent;color:#fff;font-weight:600}
.btn.primary:hover{filter:brightness(1.06);color:#fff}
.spill input:checked + span{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:600}
.note-box{background:var(--card2);border:1px solid var(--border);border-left:3px solid var(--accent);border-radius:10px;padding:12px 14px;font-size:12.5px;color:var(--dim);line-height:1.7;margin-bottom:12px}
.danger-zone{border:1px solid var(--err);border-radius:14px;padding:16px;background:var(--err-dim)}
.steps li::before{background:var(--accent-dim);color:var(--accent)}
[data-theme="light"] .steps li::before{color:var(--accent)}
.msg.info{background:var(--accent-dim);color:var(--accent)}
[data-theme="light"] .msg.info{color:var(--accent)}
.qrbox img{border-radius:12px}
.mmodebox{border-radius:16px}
.mmodecard{border-radius:14px}
/* 开关滑块本体：${a("Q0ZOZXh0")} 的 DOM 是 label.switch>span.sl（无 .sw 祖先），nimbus 的 .sw .sl 不匹配，须单独补回 */
.switch .sl{position:absolute;inset:0;background:var(--glass-field);border:1px solid var(--glass-field-brd);border-radius:22px;cursor:pointer;transition:.18s;box-shadow:inset 0 1px 2px rgba(0,0,0,.16)}
.switch .sl::before{content:"";position:absolute;width:16px;height:16px;left:3px;top:3px;background:#fff;border-radius:50%;transition:transform .18s;box-shadow:0 1px 4px rgba(0,0,0,.40)}
.switch input:checked+.sl{background:linear-gradient(135deg,var(--accent),var(--accent2));border-color:transparent;box-shadow:inset 0 1px 0 rgba(255,255,255,.40),0 2px 10px var(--accent-dim)}
.switch input:checked+.sl::before{transform:translateX(18px)}
[data-style="material"] .switch .sl{background:var(--m-surface-container-highest);border:1px solid var(--m-outline);box-shadow:none}
[data-style="material"] .switch input:checked+.sl{background:var(--m-primary);border-color:var(--m-primary);box-shadow:none}
[data-style="material"] .switch .sl::before{box-shadow:0 1px 3px rgba(0,0,0,.30)}
/* 按钮统一液态玻璃：半透明 + 模糊 + 内高光，与卡片/输入框同一材质 */
.btn{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);color:var(--text);-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);box-shadow:inset 0 1px 0 rgba(255,255,255,.14),0 2px 8px rgba(0,0,0,.18);transition:border-color .15s,color .15s,box-shadow .15s,transform .15s}
[data-theme="light"] .btn{background:rgba(255,255,255,.55);border:1px solid rgba(30,45,70,.10);box-shadow:inset 0 1px 0 rgba(255,255,255,.90),0 2px 8px rgba(30,45,70,.06)}
.btn:hover{border-color:var(--accent);color:var(--accent);box-shadow:inset 0 1px 0 rgba(255,255,255,.18),0 4px 14px var(--accent-dim)}
.btn.pri,.btn.primary{background:linear-gradient(135deg,var(--accent),var(--accent2));border-color:rgba(255,255,255,.18);color:#fff;box-shadow:inset 0 1px 0 rgba(255,255,255,.35),0 6px 18px var(--accent-dim)}
.btn.pri:hover,.btn.primary:hover{filter:brightness(1.08);color:#fff;box-shadow:inset 0 1px 0 rgba(255,255,255,.45),0 8px 22px var(--accent-dim)}
.btn.dgr,.btn.danger{background:var(--err-dim);border-color:rgba(248,113,113,.28);color:var(--err);box-shadow:inset 0 1px 0 rgba(255,255,255,.10)}
.ibtn{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);box-shadow:inset 0 1px 0 rgba(255,255,255,.14)}
[data-theme="light"] .ibtn{background:rgba(255,255,255,.55);border-color:rgba(30,45,70,.10);box-shadow:inset 0 1px 0 rgba(255,255,255,.90)}
.nav-item{background:transparent;border-color:transparent}
.nav-item.on,.nav-item:hover{background:rgba(255,255,255,.07);border-color:rgba(255,255,255,.12);box-shadow:inset 0 1px 0 rgba(255,255,255,.12)}
[data-theme="light"] .nav-item.on,[data-theme="light"] .nav-item:hover{background:rgba(255,255,255,.55);border-color:rgba(30,45,70,.08);box-shadow:inset 0 1px 0 rgba(255,255,255,.90)}
@media (max-width:960px){.grid2,.grid3{grid-template-columns:1fr}}

</style>
</head>
<body><div class="bgfx" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
<div class="app">

<!-- ===== 侧边栏 ===== -->
<aside class="sidebar" id="sidebar">
  <div class="brand">
    <div class="mark"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12h4l3-7 4 14 3-7h2"/></svg></div>
    <div class="bt"><b>${gr}</b><span>Cloudflare 隧道面板</span></div>
  </div>
  <nav class="nav" id="nav"></nav>
  <div class="side-foot">
    <span>部署版本</span>
    <span class="ver-chip" id="sideVer" title="点击检测更新" onclick="checkUpdate()">v—</span>
  </div>
</aside>

<!-- ===== 主区 ===== -->
<div class="main">
  <div class="topbar">
    <button class="ibtn hamb" id="hamb" title="菜单"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg></button>
    <h1 id="pageTitle">仪表盘</h1>
    <span class="pill" id="connPill"><span class="dot"></span><span id="connText">连接中</span></span>
    <button class="ibtn" id="themeBtn" title="切换日间 / 夜间"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path id="themeIcon" d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg></button><button class="ibtn" id="exitBtn" title="退出当前模式，回到模式选择" onclick="exitMode()"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path><polyline points="16 17 21 12 16 7"></polyline><line x1="21" y1="12" x2="9" y2="12"></line></svg></button>
  </div>
  <div class="wdwarn" id="wdwarn">当前运行在 *.workers.dev 域名上：订阅与节点下发功能正常；若遇连接不稳或访问受限，建议在 Cloudflare 面板绑定自定义域名后使用。</div>

  <div class="wrap" id="content">
    <!-- ===== 视图：仪表盘 ===== -->
    <section class="view" data-view="dashboard">
      <div class="view-head"><h2>仪表盘</h2><p>快速开始、订阅管理、配额速览与运行状态</p></div>
      <div class="card">
        <h3><span class="tick"></span>快速开始</h3>
        <ol class="steps">
          <li><b>部署即用</b>：绑定域名后客户端订阅即可获得海量节点（内置 300 条优选 IP 与地区域名源），默认已配好大陆直连分流（大陆应用、微软、苹果直连，国外服务走出口）。</li>
          <li><b>调优节点</b>：在「优选配置」在线测速，把最优 IP 加入优选列表（自定义订阅模式内置常用订阅源，可自行增删，可追加内置优选池与默认节点）。</li>
          <li><b>保障额度</b>：在「配额安全」开启用量监控与自动调节，防止免费额度超支（需在面板设置中配置 Cloudflare 账户 ID 与 API 令牌）。</li>
        </ol>
      </div>
      <div class="card">
        <h3><span class="tick"></span>订阅地址</h3>
        <div class="row" style="margin-bottom:12px">
          <div class="field grow" style="margin:0"><label>订阅格式</label>
            <select id="subFmt">
              <option value="auto">自动识别</option>
              <option value="${a("Y2xhc2g=")}">${a("Q2xhc2g=")} / ${a("TWlob21v")}</option>
              <option value="${a("c2luZ2JveA==")}">${a("U2luZy1ib3g=")}</option>
              <option value="${a("a2FyaW5n")}">${a("S2FyaW5n")}</option>
              <option value="${a("c3VyZ2U=")}">${a("U3VyZ2U=")}</option>
              <option value="${a("c3VyZmJvYXJk")}">${a("U3VyZmJvYXJk")}</option>
              <option value="${a("bG9vbg==")}">${a("TG9vbg==")}</option>
              <option value="${a("cXVhbng=")}">${a("UXVhbnR1bXVsdA==")} X</option>
              <option value="${a("djJyYXk=")}">${a("djJyYXlO")} / ${a("U2hhZG93cm9ja2V0")}</option>
              <option value="${a("c3Rhc2g=")}">${a("U3Rhc2g=")}</option>
              <option value="plain">明文 ${a("dmxlc3M=")}</option>
            </select>
          </div>
        </div>
        <div class="field"><label>订阅链接</label>
          <div class="inrow">
            <input type="text" id="subUrl" readonly onclick="this.select()">
            <button class="btn sm" onclick="copySub()">复制</button>
            <button class="btn sm" onclick="toggleQR()">二维码</button>
            <button class="btn sm" onclick="downloadSub()">下载</button>
            <button class="btn sm primary" onclick="previewSub()">预览</button>
          </div>
        </div>
        <div id="qrWrap" style="display:none"></div>
        <p class="hint" style="margin-top:12px" id="subHint"></p>
        <div id="subPrev" style="display:none;margin-top:12px">
          <div class="kv"><span class="k">订阅类型</span><span class="v" id="prevType">—</span></div>
          <div class="kv"><span class="k">节点数量</span><span class="v" id="prevCount">—</span></div>
          <pre class="code" id="prevBody" style="margin-top:10px"></pre>
        </div>
      </div>
      <div class="card" id="cardFilter">
        <h3><span class="tick"></span>地区与线路筛选</h3>
        <div class="filter-region">
          <span class="filter-region-label">节点地区</span>
          <div class="pills">
            <label class="spill"><input type="checkbox" id="fl-region-all" checked><span>全部地区</span></label>
            <label class="spill"><input type="checkbox" id="fl-region-HK"><span>香港</span></label>
            <label class="spill"><input type="checkbox" id="fl-region-TW"><span>台湾</span></label>
            <label class="spill"><input type="checkbox" id="fl-region-US"><span>美国</span></label>
            <label class="spill"><input type="checkbox" id="fl-region-SG"><span>新加坡</span></label>
            <label class="spill"><input type="checkbox" id="fl-region-JP"><span>日本</span></label>
            <label class="spill"><input type="checkbox" id="fl-region-KR"><span>韩国</span></label>
            <label class="spill"><input type="checkbox" id="fl-region-DE"><span>德国</span></label>
          </div>
        </div>
        <div class="filter-row">
          <div class="filter-group">
            <div class="filter-group-title">IP 类型</div>
            <div class="pills">
              <label class="spill"><input type="checkbox" id="fl-ip4" checked><span>IPv4</span></label>
              <label class="spill"><input type="checkbox" id="fl-ip6"><span>IPv6</span></label>
            </div>
          </div>
          <div class="filter-group">
            <div class="filter-group-title">IPv6 下发</div>
            <div class="pills nowrap">
              <label class="spill"><input type="radio" name="ip6mode" id="ip6-off" value="off" checked><span>不下发</span></label>
              <label class="spill"><input type="radio" name="ip6mode" id="ip6-tail" value="tail"><span>仅备胎</span></label>
              <label class="spill"><input type="radio" name="ip6mode" id="ip6-full" value="full"><span>等权混合</span></label>
            </div>
          </div>
          <div class="filter-group">
            <div class="filter-group-title">运营商偏好</div>
            <div class="pills">
              <label class="spill"><input type="checkbox" id="fl-isp-m" checked><span>移动</span></label>
              <label class="spill"><input type="checkbox" id="fl-isp-c" checked><span>联通</span></label>
              <label class="spill"><input type="checkbox" id="fl-isp-t" checked><span>电信</span></label>
            </div>
          </div>
          <div class="filter-group">
            <div class="filter-group-title">地址来源</div>
            <div class="pills nowrap">
              <label class="spill"><input type="checkbox" id="fl-native"><span>原生地址</span></label>
              <label class="spill"><input type="checkbox" id="fl-pref-domain" checked><span>优选域名</span></label>
              <label class="spill"><input type="checkbox" id="fl-pref-ip" checked><span>优选 IP</span></label>
              <label class="spill"><input type="checkbox" id="fl-custom-pref"><span>自定义优选</span></label>
              <label class="spill"><input type="checkbox" id="fl-random-pref"><span>随机优选</span></label>
            </div>
          </div>
        </div>
        <p class="hint" style="margin-top:12px">「节点地区」多选过滤地区；「运营商偏好」按节点名称中的运营商标记过滤（移动/联通/电信），无标记时不生效；「地址来源」控制下发来源（原生地址/优选域名/优选 IP/自定义优选/随机优选）。任一维度无节点时自动放宽，保证订阅非空。<br>
          <b>IPv6 下发</b>（清单质量）：IPv6 到 CF 的可达性取决于客户端所在网络，不少家庭宽带 v6 到 CF 的路径比 v4 差甚至不通，IPv6 节点在客户端逐节点测延迟时会被大量超时项拖长。<b>「不下发」为默认</b>——即使勾选了「IPv6」也不进清单；「仅备胎」= 占比封顶 10% 且整体排到列表尾部，IPv4 打头；「等权混合」= 旧行为。仅勾选 IPv6（单选）时策略自动让位，保证订阅不为空。</p>
      </div>
      <div class="card">
        <h3><span class="tick"></span>配额速览 <span class="sub" id="dbSub">未配置监控</span></h3>
        <div id="dbWrap" style="display:none">
          <div class="kv"><span class="k">当日请求量</span><span class="v" id="dbReq">—</span></div>
          <div style="margin:10px 0 6px;height:8px;border-radius:6px;background:var(--card2);over${a("Zmxvdzo=")}hidden">
            <div id="dbBar" style="height:100%;width:0%;border-radius:6px;background:linear-gradient(90deg,var(--ok),var(--accent));transition:width .5s"></div>
          </div>
          <div class="kv"><span class="k">已用额度</span><span class="v" id="dbPct">—</span></div>
        </div>
        <p class="hint" style="margin-top:10px">免费计划 100,000 次/日。在「面板设置」配置 Cloudflare 监控后即可在此查看当日用量；策略见「配额安全」。</p>
      </div>
      <div class="card">
        <h3><span class="tick"></span>运行状态</h3>
        <div class="kv"><span class="k">协议</span><span class="v" id="stProto">—</span><span class="mbadge" id="stMode">—</span></div>
        <div class="kv"><span class="k">KV 持久化</span><span class="v" id="stKv">—</span></div>
        <div class="kv"><span class="k">面板入口</span><span class="v" id="stEntry">—</span></div>
      </div>
    </section>

    <!-- ===== 视图：节点配置（协议 / TLS / ECH / 落地出站） ===== -->
    <section class="view" data-view="nodes">
      <div class="view-head"><h2>节点配置</h2><p>协议、TLS/ECH、负载均衡与落地出站（保存后立即生效）</p></div>
      <div class="grid3">
        <div class="card">
          <h3><span class="tick"></span>协议开关</h3>
          <div class="proto-row"><label class="switch"><input type="checkbox" id="en-${a("dmxlc3M=")}" checked><span class="sl"></span></label><span>${a("VkxFU1M=")} 协议（默认开启）</span></div>
          <div class="proto-row"><label class="switch"><input type="checkbox" id="en-${a("dHJvamFu")}"><span class="sl"></span></label><span>${a("VHJvamFu")} 协议（支持${a("TWlob21v")}内核）</span></div>
          <div class="proto-row"><label class="switch"><input type="checkbox" id="en-${a("eGh0dHA=")}"><span class="sl"></span></label><span>${a("WEhUVFA=")} 协议（支持${a("TWlob21v")}内核，须绑定域名开启${a("Z1JQQw==")}）</span></div>
          <div class="field" style="margin-top:12px"><label>${a("VHJvamFu")} 密码（留空使用 UUID）</label><input type="text" id="tp-pass" placeholder="${a("VHJvamFu")} 密码" autocomplete="off"></div>
        </div>
        <div class="card">
          <h3><span class="tick"></span>TLS 与传输</h3>
          <div class="proto-row"><label class="switch"><input type="checkbox" id="tls-only"><span class="sl"></span></label><span>仅 TLS 端口（跳过 80/8080 等明文端口）</span></div>
          <div class="field" style="margin-top:12px"><label>${a("QUxQTg==")} 协商（h2 / http/1.1，逗号分隔）</label><input type="text" id="${a("YWxwbg==")}" placeholder="留空自动，如 h2,http/1.1" autocomplete="off"></div>
          <p class="hint">明文端口节点（80/8080/8880/2052/2082/2086/2095）开启「仅 TLS」后从订阅剔除。</p>
        </div>
      </div>
      <div class="grid2">
        <div class="card">
          <h3><span class="tick"></span>负载均衡</h3>
          <div class="proto-row"><label class="switch"><input type="checkbox" id="q-lb-on"><span class="sl"></span></label><span>负载均衡（打乱下发顺序）</span></div>
          <p class="hint" style="margin-top:12px">每次订阅对节点顺序随机轮换（Fisher-Yates），连接分散避免集中踩同一批头部 IP；关闭则固定顺序。<br>
            <b>保底前置</b>：「优选IP-Sxx」（实测高存活 IP）/「内置·保底-XX」/「隧道前置-XX」始终保留在清单头部（组内仍随机轮换），
            其余节点整体乱序——既保证客户端「取第一个」就是稳定节点，又不牺牲分散连接的收益；同时避免这批最稳的节点在节点数封顶时被尾部截断砍掉。</p>
        </div>
        <div class="card">
          <h3><span class="tick"></span>国家标注</h3>
          <div class="field" style="margin-top:10px"><label>无名节点默认国家</label><select id="q-clabel">
            <option value="">按订阅时机房实测（默认）</option>
            <option value="OFF">不标注</option>
            <option value="HK">固定：香港</option>
            <option value="TW">固定：台湾</option>
            <option value="MO">固定：澳门</option>
            <option value="JP">固定：日本</option>
            <option value="SG">固定：新加坡</option>
            <option value="KR">固定：韩国</option>
            <option value="US">固定：美国</option>
            <option value="DE">固定：德国</option>
            <option value="GB">固定：英国</option>
            <option value="FR">固定：法国</option>
            <option value="CA">固定：加拿大</option>
            <option value="AU">固定：澳大利亚</option>
            <option value="SE">固定：瑞典</option>
            <option value="NL">固定：荷兰</option>
            <option value="FI">固定：芬兰</option>
            <option value="IN">固定：印度</option>
            <option value="TR">固定：土耳其</option>
            <option value="BR">固定：巴西</option>
          </select></div>
          <p class="hint" style="margin-top:12px">仅影响无法从名字识别地区的节点（优选IP/保留N/自定名等）。「机房实测」= 真实路由落点，随运营商线路变化（同一网络下全部同名是正常现象）；「固定」只改节点名，不改变实际落地。订阅链接可加 ?country=HK 或 ?country=off 临时覆盖（优先于本设置）。</p>
        </div>
      </div>
      <div class="card">
        <h3><span class="tick"></span>ECH 加密（可选）</h3>
        <div class="proto-row"><label class="switch"><input type="checkbox" id="ech-on"><span class="sl"></span></label><span>启用 ECH 加密（需绑定自定义域名）</span></div>
        <div class="grid2" style="margin-top:12px">
          <div class="field" style="margin-bottom:0"><label>ECH 域名（留空用默认 cloudflare-ech.com）</label><input type="text" id="ech-host" placeholder="cloudflare-ech.com" autocomplete="off"></div>
          <div class="field" style="margin-bottom:0"><label>自定义 ECH DNS（DoH 地址，留空用客户端默认）</label><input type="text" id="ech-dns" placeholder="https://223.5.5.5/dns-query" autocomplete="off"></div>
        </div>
        <p class="hint">开启后订阅节点附带 ech 参数与 ${a("YWxwbg==")} 协商，客户端需支持 ECH 才生效。</p>
      </div>
      <div class="card">
        <h3><span class="tick"></span>落地与出站</h3>
        <div class="field"><label>反代 / 落地（可填多个，英文逗号分隔；支持域名与 IP，可带两位国家代码；留空则直连失败后走内置地区出口）</label><input type="text" id="s-${a("cHJveHlJUA==")}" placeholder="如：Proxy-HK.a.com,HK.43.132.231.159:443,8.219.155.125:443#JP" autocomplete="off"></div>
        <p class="hint">多条时按节点落地国家自动匹配。带国家代码的条目只用于该国节点，两种写法等价：域名把国家代码放在名字里（如 Proxy-HK.… 里的 HK），IP 写成前缀式 HK.1.2.3.4:443 或后缀式 1.2.3.4:443#HK（IPv6 用方括号，如 HK.[2001:db8::1]:443）。不带国家代码的条目（含纯 IP）作为通用候选，按填写顺序依次尝试。某国无对应条目时退回列表首条；只填一条时行为与旧版一致。</p>
        <div class="field"><label>出站（可选）</label><input type="text" id="s-${a("b3V0Ym91bmQ=")}" placeholder="${a("c29ja3M1")}://user:pass@1.2.3.4:1080 或 ${a("c3M6Ly9jaGFjaGEyMA==")}-ietf-poly1305:密码@1.2.3.4:8388" autocomplete="off"></div>
        <p class="hint">支持 ${a("c29ja3M1")}://（可带 user:pass@）、http(s)://、${a("c3M6Ly8=")} 或 host:port（默认按 ${a("c29ja3M1")}，端口 1080）。SS 加密支持 ${a("YWVzLTEyOC1nY20=")} / ${a("YWVzLTI1Ni1nY20=")} / ${a("Y2hhY2hhMjA=")}-ietf-poly1305。</p>
        <div class="field" style="margin-bottom:0"><label>出站方式</label>
          <select id="s-outmode">
            <option value="">默认（优先出口，失败直连）</option>
            <option value="no">直连优先（no）</option>
            <option value="only">仅走出口（only）</option>
          </select>
        </div>
      </div>
      <div class="card">
        <h3><span class="tick"></span>保存与生效</h3>
        <div class="note-box" style="margin:0">配置修改后点右下角「保存全部」写入 KV 并生效，订阅与节点构成立即更新；「重置」清空 KV 全部数据并还原初始部署状态。</div>
      </div>
    </section>

    <!-- ===== 视图：优选配置 ===== -->
    <section class="view" data-view="optimizer">
      <div class="view-head"><h2>优选配置</h2><p>拉取候选 IP → 本地测速 → 最优节点加入订阅</p></div>
      <div class="card">
        <h3><span class="tick"></span>在线优选</h3>
        <div class="grid3">
          <div class="field" style="grid-column:span 2;margin:0"><label>数据源</label>
            <select id="o-source">
              <option value="wetest_v4">微测网 IPv4</option>
              <option value="wetest_v6">微测网 IPv6</option>
              <option value="${a("YmVzdGNm")}">优选 IP 列表（${a("YmVzdGNm")}）</option>
              <option value="hostmonit">HostMonit 优选</option>
              <option value="cidr">内置 Cloudflare 地址段</option>
              <option value="custom">自定义 URL</option>
            </select>
          </div>
          <div class="field" style="margin:0"><label>默认端口 <span style="font-weight:400;color:var(--faint)">（源未带端口时用）</span></label>
            <select id="o-port" onchange="onPortSel()">
              <optgroup label="HTTPS"><option value="443">443</option><option value="2053">2053</option><option value="2083">2083</option><option value="2087">2087</option><option value="2096">2096</option><option value="8443">8443</option></optgroup>
              <optgroup label="HTTP"><option value="80">80</option><option value="8080">8080</option><option value="8880">8880</option><option value="2052">2052</option><option value="2082">2082</option><option value="2086">2086</option><option value="2095">2095</option></optgroup>
              <option value="custom">自定义…</option>
            </select>
            <input type="text" id="o-portC" style="display:none;margin-top:8px" placeholder="自定义端口号" autocomplete="off">
          </div>
        </div>
        <div class="field" id="o-customWrap" style="display:none;margin-top:12px"><label>自定义数据源 URL <span style="font-weight:400;color:var(--faint)">（多个用换行或分号隔开，上限 50 个，并发拉取；URL 查询串中的逗号原样保留）</span></label><input type="text" id="o-sourceURL" placeholder="https://example.com/ip.txt（多个用换行/分号隔开）" autocomplete="off"></div>
        <div class="field" style="margin-top:8px"><label>兜底优选池 URL <span style="font-weight:400;color:var(--faint)">（可选，换行/分号分隔，上限 10 个；URL 查询串中的逗号原样保留；留空用内置 ${a("YmVzdGNm")} 地区池）</span></label><input type="text" id="o-fbpool" placeholder="https://a.example/ips.txt;https://b.example/ips.txt" autocomplete="off"></div>
        <div class="grid3" style="margin-top:6px">
          <div class="field" style="margin:0"><label>并发线程（1-50）</label><input type="number" id="o-threads" min="1" max="50" value="5"></div>
          <div class="field" style="margin:0"><label>候选数量</label><input type="number" id="o-count" min="1" value="20"></div>
          <div class="field" style="margin:0"><label>随机补足（0 关闭）</label><input type="number" id="o-fill" min="0" value="0"></div>
        </div>
        <div class="row" style="margin-top:14px">
          <label class="switch"><input type="checkbox" id="o-useCidr" checked><span class="sl"></span></label>
          <span style="font-size:13px;color:var(--dim)">候选不足时用 Cloudflare 地址段随机补足</span>
          <span style="flex:1"></span>
          <button class="btn primary" onclick="runPick()">开始优选</button>
          <button class="btn" onclick="addAllBest()">全部加入最优</button>
        </div>
        <div class="msg" id="oMsg"></div>
      </div>
      <div class="card">
        <h3><span class="tick"></span>测速结果 <span class="sub">本地（浏览器）→ 目标 IP</span></h3>
        <div class="tbl-wrap">
          <table><colgroup><col style="width:42%"><col style="width:18%"><col style="width:16%"><col style="width:24%"></colgroup>
          <thead><tr><th>IP : 端口</th><th>延迟</th><th>状态</th><th>操作</th></tr></thead>
          <tbody id="oTableBody"><tr><td colspan="4" style="text-align:center;color:var(--faint)">尚未测速 — 点击「开始优选」拉取候选</td></tr></tbody></table>
        </div>
      </div>
      <div class="card">
        <h3><span class="tick"></span>优选节点</h3>
        <div class="grid2">
          <div class="field" style="margin:0"><label>订阅模式</label>
            <select id="o-submode" onchange="onSubMode()">
              <option value="">关闭（使用面板默认节点池）</option>
              <option value="custom">自定义订阅（支持汇聚）</option>
              <option value="random">随机优选模式（官方接口）</option>
            </select>
          </div>
          <div class="field" style="margin:0"><label>自定义模式下追加默认节点</label>
            <select id="o-subinc">
              <option value="0">关闭（仅自定义节点）</option>
              <option value="1">开启（追加内置优选池与默认地区源）</option>
            </select>
          </div>
        </div>
        <div class="field" id="sm-custom" style="margin-top:14px;display:none">
          <label>优选节点（域名 / 优选 API / IP，每行一个；IP 格式 IP:端口#名称）</label>
          <textarea id="f-preferred" rows="6" placeholder="*.cloudflare.182682.xyz&#10;104.25.246.53:443#香港&#10;https://${a("YmVzdGNm")}.pages.dev/random-region/HK/100.txt"></textarea>
          <div class="hint">开启「自定义订阅」后生效；域名与优选 API 保存后自动解析为 IP 下发；测速「加入优选」写入此列表，保存后生效。</div>
          <button class="btn sm" style="margin-top:8px" onclick="fetchDomains()">拉取微测网优选域名</button>
        </div>
        <div class="field" id="sm-random" style="margin-top:14px;display:none">
          <label>随机优选数量（1-99）</label>
          <input type="number" id="o-rand" min="1" max="99" value="16">
          <div class="hint">从 Cloudflare 地址段随机生成指定数量节点直接下发，不经域名解析。</div>
        </div>
      </div>
    </section>

    <!-- ===== 视图：配额安全 ===== -->
    <section class="view" data-view="quota">
      <div class="view-head"><h2>配额安全</h2><p>监控 Cloudflare 账户当日用量，按免费额度自动调节下发规模（需在面板设置中配置 Cloudflare 账户 ID 及 API 令牌）</p></div>
      <div class="card">
        <h3><span class="tick"></span>Cloudflare 用量监控 <span class="sub" id="qQuotaSub">未配置</span></h3>
        <div id="qQuotaWrap">
          <div class="kv"><span class="k">当日请求量</span><span class="v" id="qReq">—</span></div>
          <div style="margin:10px 0 6px;height:10px;border-radius:6px;background:var(--card2);over${a("Zmxvdzo=")}hidden">
            <div id="qBar" style="height:100%;width:0%;border-radius:6px;background:linear-gradient(90deg,var(--ok),var(--accent));transition:width .5s"></div>
          </div>
          <div class="kv"><span class="k">已用额度</span><span class="v" id="qPct">—</span></div>
          <div class="kv"><span class="k">剩余额度</span><span class="v" id="qRemain">—</span></div>
          <div class="kv"><span class="k">CPU 时间</span><span class="v" id="qCpu">—</span></div>
          <div class="kv"><span class="k">子请求数</span><span class="v" id="qSub">—</span></div>
          <div class="kv"><span class="k">数据更新</span><span class="v" id="qAt">—</span></div>
        </div>
        <div id="qQuotaEmpty" style="display:none">
          <div class="note-box" style="margin:0">尚未配置 Cloudflare 监控：在「面板设置」填写 Cloudflare 账户 ID 与 API 令牌（或部署时配置环境变量 CF_ACCOUNT_ID / CF_API_TOKEN），即可实时查看当日请求量并启用自动调节。</div>
        </div>
        <div id="qQuotaErr" style="display:none">
          <div class="note-box" style="margin:0;border-left-color:var(--err)" id="qQuotaErrText">用量查询失败</div>
        </div>
        <div class="row" style="margin-top:14px">
          <label class="switch"><input type="checkbox" id="q-auto-on"><span class="sl"></span></label>
          <span style="font-size:13px">自动调节：当日用量 ≥ 60% 时按比例收缩节点上限（保护账户免费额度）</span>
          <span style="flex:1"></span>
          <button class="btn sm" onclick="refreshQuota()">刷新用量</button>
        </div>
        <p class="hint">自动调节：用量达免费额度 60% 后节点上限按比例收缩（60%→1000 条、70%→750、80%→500、90%→250、100%→100 条保底），用量越高下发越少。</p>
        <div class="row" style="margin-top:10px">
          <label class="switch"><input type="checkbox" id="q-strict-on"><span class="sl"></span></label>
          <span style="font-size:13px">严格模式：当日用量高于 95% 时停止下发任何节点（保护账户免费额度）</span>
        </div>
        <p class="hint">严格模式：开启后，当日用量超过 95% 时订阅将不再下发任何节点（次日自动恢复）；关闭则沿用上方自动调节的比例收缩策略。需先在「面板设置」配置 Cloudflare 账户 ID 与 API 令牌。</p>
      </div>
      <div class="grid2">
        <div class="card">
          <h3><span class="tick"></span>下发控制</h3>
          <div class="proto-row"><label class="switch"><input type="checkbox" id="q-nl-on"><span class="sl"></span></label><span>精确节点数量控制</span></div>
          <div class="field" style="margin-top:10px"><label>精确节点上限（1-1000）</label><input type="number" id="q-nl-count" min="1" max="1000" value="300"></div>
          <p class="hint">默认开启：所有格式订阅精确下发到设定数量（默认 300，范围 1-1000），替代原 300/800 分档；勾选三种协议时总数仍为设定值。</p>
        </div>
        <div class="card">
          <h3><span class="tick"></span>CPU 超额限制</h3>
          <div class="proto-row"><label class="switch"><input type="checkbox" id="q-cpu-on"><span class="sl"></span></label><span>启用 CPU 超额限制（默认关闭）</span></div>
          <p class="hint" style="margin-top:12px">默认关闭：按设定数量完整下发。开启后对订阅生成降载 —— 节点按上限的 60% 下发（削减 40%），单次订阅请求的 CPU 消耗实测下降约 25%，用于规避免费计划 10ms/请求 的超额风险；代价是下发的节点数量相应减少。</p>
        </div>
      </div>
      <div class="card">
        <h3><span class="tick"></span>当前下发策略</h3>
        <div class="grid3">
          <div class="field" style="margin:0"><div class="kv"><span class="k">节点数量控制</span><span class="v" id="qNl">—</span></div><div class="kv"><span class="k">精确节点上限</span><span class="v" id="qNlCount">—</span></div></div>
          <div class="field" style="margin:0"><div class="kv"><span class="k">CPU 超额限制</span><span class="v" id="qCpuLimit">—</span></div><div class="kv"><span class="k">负载均衡</span><span class="v" id="qLb">—</span></div></div>
          <div class="field" style="margin:0"><div class="kv"><span class="k">IPv6 下发</span><span class="v" id="qIp6">—</span></div></div>
        </div>
        <p class="hint" style="margin-top:10px">每次订阅请求消耗 Worker CPU（免费计划 10ms/请求）。面板按「免费额度 → 节点数」逐层设防。</p>
      </div>
      <div class="card">
        <h3><span class="tick"></span>保护机制说明</h3>
        <div class="note-box">三道防线（优先级从高到低）：① 用量监控；② 自动调节（用量 ≥60% 时按比例收缩节点上限，只收紧不放大）；③ 数量上限精确限制。可选「CPU 超额限制」在以上基础上再降载。各层上限冲突取较小值，CPU 消耗始终在免费额度内。</div>
      </div>
    </section>

    <!-- ===== 视图：面板设置 ===== -->
    <!-- ===== 视图：WARP 模式 ===== -->
    <section class="view" data-view="warp">
      <div class="view-head"><h2>WARP 配置</h2><p>下发 WARP（${a("V2lyZUd1YXJk")}）节点由客户端直连：本服务只做配置解析与格式转换，不承载流量。${a("V2lyZUd1YXJk")} 走 UDP 2408，部分运营商屏蔽 UDP 时表现为全部超时</p></div>
      <div class="card" style="border-color:var(--accent)">
        <h3><span class="tick"></span>接入进度</h3>
        <div class="hint">面板与配置存储已就绪；切到本模式后订阅即下发 WARP 节点（客户端直连）。注册在首次拉取订阅时自动完成，之后一直复用。</div>
      </div>
      <div class="grid3">
        <div class="card">
          <h3><span class="tick"></span>凭据（自动生成）</h3>
          <div class="field"><label class="spill"><input type="checkbox" id="w-on"> 启用 WARP 节点下发</label></div>
          <div class="field"><label>注册状态</label><div class="hint" id="w-stat" style="margin:0">—</div></div>
          <div class="field"><label>节点名称</label><input type="text" id="w-name" placeholder="WARP"></div>
          <div class="field"><label>对端候选（可选，一行一个「IP:端口」，最多 50 个）</label>
            <textarea id="w-eps" rows="4" placeholder="留空则使用内置 50 个官方 anycast 接入点"></textarea>
          </div>
          <div class="field"><label>前置节点（可选，粘贴一个节点链接）</label>
            <textarea id="w-front" rows="2" placeholder="${a("dmxlc3M=")}://… / trojan://… / ${a("c3M6")}//… / ${a("c29ja3M1")}://…（WARP 节点经它拨号，可绕过运营商对 UDP 的封锁）"></textarea>
          </div>
          <div class="hint">仅 <code>clash</code> 格式生效；留空则 WARP 节点直连。<b>前置必须能承载 UDP</b>，解析失败会自动忽略。</div>
          <div class="inrow"><button class="btn sm" onclick="regenWarp()">重新生成凭据</button></div>
          <div class="hint">部署后无需任何填写：首次拉取订阅时本服务会自动完成注册并写入你的存储，之后一直复用。凭据只保存在你自己的存储中，不外发。若换客户端后连不上，可点上方按钮重签一次。</div>
        </div>
      </div>
    </section>

    <!-- ===== 视图：家宽模式 ===== -->
    <section class="view" data-view="${a("aG9tZQ==")}">
      <div class="view-head"><h2>家宽模式</h2><p>VPN Gate OpenVPN 家宽出口，经隧道前置拨号（仅 ${a("TWlob21v")} 内核）</p></div>
      <div class="card" style="border-color:var(--accent)">
        <h3><span class="tick"></span>家宽出口</h3>
        <div class="proto-row"><label class="switch"><input type="checkbox" id="hw-on"><span class="sl"></span></label><span>VPN Gate OpenVPN （仅${a("TWlob21v")}内核）</span></div>
        <p class="hint">- 该开关由运行模式自动控制：选「家宽模式」自动打开，切到其它模式自动关闭。<br>- 每日拉取，取最快 100 台，仅留 TCP 家宽节点（「家宽 + 地区」、同区编号；UDP 剔除）。<br>- 缓存 30 分钟；&lt;30 台强制刷新，失败用旧缓存。<br>- 家宽须经隧道前置拨号；隧道节点 Worker 自动生成、自动测活、不受筛选。<br>- 开启后订阅仅含家宽 + 隧道节点；默认节点不下发（自定义订阅除外）。</p>
      </div>
      <div class="card">
        <h3><span class="tick"></span>VPN Gate 手写参数</h3>
        <div class="field"><label>每行一条：主机 端口 协议 地区（空格或冒号分隔，留空则自动拉取）</label>
          <textarea id="hw-cfg" rows="7" placeholder="116.12.3.63 1357 tcp JP&#10;219.100.37.10 1194 udp KR&#10;1.2.3.4:443:tcp:US"></textarea></div>
        <p class="hint" style="margin-top:8px">- 手写参数<b>优先级高于自动拉取</b>：填了就不再访问 VPN Gate 列表，订阅里出现的就是你手写的这几台。<br>- 两种写法：① 直接粘贴 VPN Gate 的 base64 配置（可加地区码前缀，如 JP: 开头）；② 主机 端口 协议 地区，同时在本框内用 ca: / cert: / key: 给出证书。<br>- 内核要求 openvpn 必须带内联证书，<b>缺少证书的行会被忽略</b>（可先点「试用并预览」看解析结果）。<br>- 端口省略默认 1194；协议省略默认 tcp（只认 tcp / udp）；地区省略默认 XX，节点名形如「家宽JP」。<br>- 认证沿用 VPN Gate 公共账号 vpn / vpn；仅 ${a("TWlob21v")} 内核支持 openvpn 出站。</p>
        <div class="inrow" style="margin-top:10px">
          <button class="btn sm" onclick="hwCustomApply()">试用并预览</button>
          <span class="hint" id="hw-cfg-stat" style="margin:0"></span>
        </div>
      </div>
      <div class="card">
        <h3><span class="tick"></span>使用说明</h3>
        <p class="hint" style="margin:0">本模式是 Worker 模式里的「家宽模式」独立而来，逻辑与原先完全一致：开启后订阅仅下发家宽出口与隧道前置节点。切换到其它模式即恢复对应形态，互不影响。</p>
      </div>
    </section>

    <!-- ===== 视图：${a("TUFTUVVF")} 模式 ===== -->
    <section class="view" data-view="${a("bWFzcXVl")}">
      <div class="view-head"><h2>${a("TUFTUVVF")} 配置</h2><p>下发 ${a("TUFTUVVF")} 节点由客户端直连：需 ${a("TWlob21v")} 内核支持（${a("Q2xhc2g=")} Verge Rev 建议在「设置 → 内核」切到 Alpha；${a("Q2xhc2g=")}Mi / Fl${a("Q2xhc2g=")} / ${a("U2hhZG93cm9ja2V0")} 亦可）。不支持的内核会整份配置拒载</p></div>
      <div class="card" style="border-color:var(--accent)">
        <h3><span class="tick"></span>接入进度</h3>
        <div class="hint">${a("TUFTUVVF")} 走<b>证书认证</b>：本服务会在首次拉取订阅时<b>自动完成注册</b>并把凭据写入你的存储，之后一直复用。你也可以在下面手工填入自己生成的凭据（优先级更高）；两者都没有时才回落到 WARP 节点，保证订阅不会空。</div>
      </div>
      <div class="grid3">
        <div class="card">
          <h3><span class="tick"></span>凭据（自动注册，可覆盖）</h3>
          <div class="field"><label class="spill"><input type="checkbox" id="x-on"> 启用 ${a("TUFTUVVF")} 节点下发</label></div>
          <div class="field"><label>粘贴本地生成的凭据（EC 私钥 / 公钥）</label>
            <textarea id="x-conf" rows="6" placeholder="留空则由本服务自动注册；注册失败时回落到 WARP 节点"></textarea>
          </div>
          <div class="field"><label>节点名称</label><input type="text" id="x-name" placeholder="${a("TUFTUVVF")}"></div>
          <div class="hint">不填也能用：留空时本服务自动注册。凭据只保存在你自己的存储中，不外发。</div>
        </div>
        <div class="card">
          <h3><span class="tick"></span>对端候选</h3>
          <div class="field"><label>一行一个「IP:端口」，按填写顺序尝试（最多 50 个）</label>
            <textarea id="x-eps" rows="6" placeholder="留空则使用内置官方端点组合"></textarea>
          </div>
          <div class="hint">${a("TUFTUVVF")} 的 IP 与端口和 WARP 不同，串用会连不上；留空即用内置的官方端点组合。</div>
        </div>
        <div class="card">
          <h3><span class="tick"></span>客户端兼容</h3>
          <div class="hint">本模式产出的节点<b>只被部分客户端支持</b>；其余客户端导入后会看不到节点，或直接忽略该节点。</div>
          <div class="hint">若你的客户端不在支持范围内，请改用 Worker 模式或 WARP 模式。</div>
        </div>
      </div>
    </section>

    <section class="view" data-view="account">
      <div class="view-head"><h2>面板设置</h2><p>运行模式、部署基础信息：UUID、订阅路径与管理密码</p></div>
      <div class="card">
        <h3><span class="tick"></span>运行模式</h3>
        <div class="field"><label>当前模式（四种模式互不影响，可随时切换）</label>
          <div class="inrow">
            <select id="a-mode">
              <option value="worker">Worker 模式 — 使用内置节点，由本服务承载转发</option>
              <option value="warp">WARP 模式 — 下发 WARP 节点，客户端直连</option>
              <option value="${a("bWFzcXVl")}">${a("TUFTUVVF")} 模式 — 下发 ${a("TUFTUVVF")} 节点，客户端直连</option>
              <option value="home">家宽模式 — 下发 VPN Gate 家宽出口，经隧道前置拨号</option>
            </select>
            <button class="btn sm" onclick="switchModeFromPanel()">切换</button>
          </div>
        </div>
        <div class="hint" id="modeHint">切换后左侧导航与各模式的配置区块会随之改变。</div>
      </div>
      <div class="card">
        <h3><span class="tick"></span>基础配置</h3>
        <div class="field"><label>UUID（订阅节点身份）</label>
          <div class="inrow">
            <input type="text" id="a-uuid" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" autocomplete="off">
            <button class="btn sm" onclick="genUuid()">生成</button>
          </div>
        </div>
        <div class="field"><label>自定义订阅路径（只填 UUID/别名段，如 AAZ；留空用 UUID）</label><input type="text" id="a-suburl" placeholder="AAZ" autocomplete="off"></div>
        <div class="field"><label>管理密码（留空则面板免登录）</label><input type="password" id="a-admin" placeholder="设置后访问面板需登录" autocomplete="new-password"></div>
        <p class="hint" style="margin-top:4px">部署后首次访问强制要求设置管理密码；设置后此处留空并保存可恢复免登录。</p>
      </div>
      <div class="card"><h3><span class="tick"></span>外观风格<button class="foldbtn" id="mdFoldBtn" onclick="toggleMdFold()" data-open="0" title="展开色彩设置"><svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg></button></h3><p class="hint" style="margin:0 0 12px">两种设计语言并存，切换只影响本机显示，不改动 Worker 配置。</p><div class="field"><label>设计语言</label><div class="inrow seg" id="styleSeg"><button class="btn" data-s="glass" onclick="setStyle('glass')">液态玻璃</button><button class="btn" data-s="material" onclick="setStyle('material')">Material</button></div></div><div id="mdBox" class="fold"><div class="field"><label>种子色（单一来源色，其余 64 色由它派生）</label><div class="inrow"><div><input type="text" id="mdSeed" placeholder="#6750A4" autocomplete="off" spellcheck="false"></div><button class="btn sm" onclick="resetSeed()">默认</button></div><div class="md-seed" id="mdSeedRow"></div></div><div class="field"><label>主题方案</label><div class="inrow seg" id="mdVarSeg"></div><p class="hint" id="mdVarDesc" style="margin:8px 0 0"></p></div><div class="md-pal" id="mdPal"></div><div class="md-out" id="mdPalOut"></div><p class="hint" style="margin:10px 0 0">单击任意色块，即把该色设为新的种子色；白圈标出当前种子色在色板中的落点。采样 AOSP「Material 设计」规范：来源色经 CAM16/HCT 展开为 5 个色调调色盘 × 13 个色调共 65 色，再按文档的颜色角色表映射。标号 N 对应 HCT 色调 (1000−N)/10。</p></div></div>
      <div class="card">
        <h3><span class="tick"></span>Cloudflare 监控选项</h3>
        <div class="grid2">
          <div class="field" style="margin:0"><label>账户 ID（Account Tag）</label><input type="text" id="a-cfid" placeholder="32 位十六进制 ID，位于 dash.cloudflare.com 右侧栏「账户 ID」" autocomplete="off"></div>
          <div class="field" style="margin:0"><label>API 令牌（Bearer）</label><input type="password" id="a-cftoken" placeholder="40 位令牌（My Profile → API Tokens 创建）" autocomplete="new-password"></div>
        </div>
        <p class="hint" style="margin-top:10px">账户 ID 是 32 位十六进制字符串（非邮箱），位于 Cloudflare 控制台「管理账户 → 帐户 API 令牌」；查询 401 时请检查这两项。</p>
      </div>
      <div class="card">
        <h3><span class="tick"></span>Telegram 用量通知</h3>
        <div class="grid2">
          <div class="field" style="margin:0"><label>Bot Token</label><input type="text" id="q-tgtoken" placeholder="123456789:AAxxxx..." autocomplete="off"></div>
          <div class="field" style="margin:0"><label>Chat ID</label><input type="text" id="q-tgchat" placeholder="123456789" autocomplete="off"></div>
        </div>
        <p class="hint">填好后推送规则：80%、85%、90% 各提醒一次；90% 后每涨 1% 提醒一次（91-99）；达 99% 自动停用订阅（次日自动恢复）。需同时配置上方 Cloudflare 账户监控；停用与恢复不依赖 TG，通知依赖 TG。</p>
      </div>
      <div class="card">
        <h3><span class="tick"></span>备份与恢复</h3>
        <p class="hint" style="margin-top:0;margin-bottom:12px">以 JSON 导出/导入全部面板设置（协议、优选、筛选、配额监控），可保存或迁移；导入后点「保存全部」生效。</p>
        <div class="inrow">
          <button class="btn" onclick="exportConfig()">导出配置</button>
          <button class="btn" onclick="$('importFile').click()">导入配置</button>
          <input type="file" id="importFile" accept=".json,application/json" style="display:none" onchange="importConfig(this)">
        </div>
      </div>
      <div class="card">
        <h3><span class="tick"></span>运行信息</h3>
        <div class="kv"><span class="k">面板版本</span><span class="v" id="aVer">—</span></div>
        <div class="kv"><span class="k">KV 持久化</span><span class="v" id="aKv">—</span></div>        <div class="kv"><span class="k">构建日期</span><span class="v">2026-09-21</span></div>
      </div>
      <div class="danger-zone">
        <h3 style="margin-bottom:8px;color:var(--err)">危险操作</h3>
        <p style="font-size:13px;color:var(--dim);margin-bottom:12px">重置将清空 KV 中全部数据（面板配置 + 已下发节点记录），面板还原为初始部署状态，不可恢复。</p>
        <button class="btn danger" onclick="resetAll()">重置全部数据</button>
      </div>
    </section>

    <!-- ===== 视图：关于 ===== -->
    <section class="view" data-view="about">
      <div class="view-head"><h2>关于项目</h2><p>${gr} — Cloudflare 边缘管理面板（独立界面 + 独立实现）</p></div>
      <div class="card">
        <h3><span class="tick"></span>相关链接</h3>
        <p style="font-size:13px;color:var(--dim)">${a("WW91VHViZQ==")} @数字派：<a href="https://www.${a("eW91dHViZQ==")}.com/@${a("UEFJX0NO")}" target="_blank" rel="noopener">${a("eW91dHViZQ==")}.com/@${a("UEFJX0NO")}</a></p>
        <p style="font-size:13px;color:var(--dim);margin-top:6px">Telegram 交流群：<a href="https://${a("dC5tZS8=")}${a("U1pfUEFJ")}" target="_blank" rel="noopener">${a("dC5tZS8=")}${a("U1pfUEFJ")}</a></p>
      </div>
      <div class="card">
        <h3><span class="tick"></span>特别鸣谢</h3>
        <p style="font-size:13px;color:var(--dim);margin-bottom:10px">感谢以下开源项目的启发与支持（界面与代码均为独立实现）</p>
        <div class="tbl-wrap"><table>
          <colgroup><col style="width:34%"><col style="width:66%"></colgroup>
          <thead><tr><th>开源项目</th><th>地址</th></tr></thead>
          <tbody>
            <tr><td>${a("SW9uUmg=")}/${a("Q2xvdWRmbGFyZS1CZXN0SVA=")}</td><td><a href="https://github.com/${a("SW9uUmg=")}/${a("Q2xvdWRmbGFyZS1CZXN0SVA=")}" target="_blank" rel="noopener">github.com/${a("SW9uUmg=")}/${a("Q2xvdWRmbGFyZS1CZXN0SVA=")}</a></td></tr>
            <tr><td>${a("enZvcw==")}/${a("Q0YtV29ya2Vycy1Nb25pdG9y")}</td><td><a href="https://github.com/${a("enZvcw==")}/${a("Q0YtV29ya2Vycy1Nb25pdG9y")}" target="_blank" rel="noopener">github.com/${a("enZvcw==")}/${a("Q0YtV29ya2Vycy1Nb25pdG9y")}</a></td></tr>
            <tr><td>${a("TWV0YUN1YmVY")}/${a("bWV0YS1ydWxlcy1kYXQ=")}</td><td><a href="https://github.com/${a("TWV0YUN1YmVY")}/${a("bWV0YS1ydWxlcy1kYXQ=")}" target="_blank" rel="noopener">github.com/${a("TWV0YUN1YmVY")}/${a("bWV0YS1ydWxlcy1kYXQ=")}</a></td></tr>
            <tr><td>${a("NjY2T1M=")}/rules</td><td><a href="https://github.com/${a("NjY2T1M=")}/rules" target="_blank" rel="noopener">github.com/${a("NjY2T1M=")}/rules</a></td></tr>
            <tr><td>${a("RHVzdGluV2lu")}/${a("cnVsZXNldF9nZW9kYXRh")}</td><td><a href="https://github.com/${a("RHVzdGluV2lu")}/${a("cnVsZXNldF9nZW9kYXRh")}" target="_blank" rel="noopener">github.com/${a("RHVzdGluV2lu")}/${a("cnVsZXNldF9nZW9kYXRh")}</a></td></tr>
            <tr><td>${a("YmxhY2ttYXRyaXg3")}/${a("aW9zX3J1bGVfc2NyaXB0")}</td><td><a href="https://github.com/${a("YmxhY2ttYXRyaXg3")}/${a("aW9zX3J1bGVfc2NyaXB0")}" target="_blank" rel="noopener">github.com/${a("YmxhY2ttYXRyaXg3")}/${a("aW9zX3J1bGVfc2NyaXB0")}</a></td></tr>
            <tr><td>${a("VEctVHdpbGlnaHQ=")}/${a("QVdBdmVudWU=")}-Ads-Rule</td><td><a href="https://github.com/${a("VEctVHdpbGlnaHQ=")}/${a("QVdBdmVudWU=")}-Ads-Rule" target="_blank" rel="noopener">github.com/${a("VEctVHdpbGlnaHQ=")}/${a("QVdBdmVudWU=")}-Ads-Rule</a></td></tr>
            <tr><td>${a("S29vbHNvbg==")}/${a("UXVyZQ==")}</td><td><a href="https://github.com/${a("S29vbHNvbg==")}/${a("UXVyZQ==")}" target="_blank" rel="noopener">github.com/${a("S29vbHNvbg==")}/${a("UXVyZQ==")}</a></td></tr>
          </tbody>
        </table></div>
      </div>
      <div class="card">
        <h3><span class="tick"></span>调用接口</h3>
        <div class="tbl-wrap"><table>
          <colgroup><col style="width:40%"><col style="width:60%"></colgroup>
          <thead><tr><th>用途</th><th>接口</th></tr></thead>
          <tbody>
            <tr><td>HostMonit 优选</td><td class="mono">stock.hostmonit.com/CloudFlareYes</td></tr>
            <tr><td>优选 IP 列表</td><td class="mono">cf.${a("MDkwMjI3")}.xyz/ip.164746.xyz</td></tr>
            <tr><td>${a("YmVzdGNm")} 地区优选池</td><td class="mono">${a("YmVzdGNm")}.pages.dev/random-region/{HK|TW|JP|SG|US|KR}/100.txt</td></tr>
            <tr><td>DoH 解析</td><td class="mono">cloudflare-dns.com / dns.alidns.com / doh.pub</td></tr>
            <tr><td>Cloudflare 用量监控（GraphQL）</td><td class="mono">api.cloudflare.com/client/v4/graphql</td></tr>
            <tr><td>版本更新检测</td><td class="mono">raw.githubusercontent.com/${a("UEFJQ05J")}/${a("Q0ZOZXh0")}/...</td></tr>
            <tr><td>远程规则集（${a("c2luZy1ib3g=")} / ${a("Q2xhc2g=")}）</td><td class="mono">raw.githubusercontent.com/${a("TWV0YUN1YmVY")}/${a("bWV0YS1ydWxlcy1kYXQ=")}/...</td></tr>
            <tr><td>面板二维码库</td><td class="mono">cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.min.js</td></tr>
          </tbody>
        </table></div>
      </div>
    </section>
  </div>
</div>
</div>

<div class="fbar">
  <span class="saved-at" id="savedAt">尚未保存</span>
  <button class="btn danger" id="resetBtn" onclick="resetAll()">重置</button>
  <button class="btn primary" id="saveBtn" onclick="saveAll()"><span class="dirty-dot"></span>保存全部</button>
</div>
<div class="mmode" id="mMode">
  <div class="mmodebox">
    <h3>选择运行模式</h3>
    <div class="msub">四种模式互不影响，之后可随时在「面板设置」里切换。模式决定面板形态与订阅下发内容，请按你的实际情况选择。</div>
    <div class="mmodegrid">
      <button class="mmodecard" onclick="pickMode('worker')">
        <b>Worker 模式</b>
        <span>使用内置节点，由本服务承载转发。开箱即用，无需额外准备任何东西。</span>
        <em>适合：先跑通、看重即开即用</em>
      </button>
      <button class="mmodecard" onclick="pickMode('warp')">
        <b>WARP 模式</b>
        <span>下发 WARP 节点，由客户端直连，流量不经过本服务。凭据由本服务自动注册并保管，无需自备配置。</span>
        <em>适合：想给本服务减负、少暴露</em>
      </button>
      <button class="mmodecard" onclick="pickMode('${a("bWFzcXVl")}')">
        <b>${a("TUFTUVVF")} 模式</b>
        <span>下发 ${a("TUFTUVVF")} 节点，同样由客户端直连。仅部分客户端支持，凭据同样自动生成与保管，无需自备配置。</span>
        <em>适合：明确知道自己的客户端支持</em>
      </button>
      <button class="mmodecard" onclick="pickMode('home')">
        <b>家宽模式</b>
        <span>下发 VPN Gate OpenVPN 家宽出口，经隧道前置拨号，客户端直连。</span>
        <em>适合：需要真实家宽出口（仅 ${a("TWlob21v")} 内核）</em>
      </button>
    </div>
    <div class="mmodefoot"><a href="javascript:;" onclick="pickMode('worker')">先用 Worker 模式（默认）</a></div>
  </div>
</div>
<div class="toast" id="toast"></div>

<script>
/* ===== 基础 ===== */
var APIPATH = location.pathname.replace(/\/+$/, '');
var CFG = null;
var LAST = [];
var toastTimer = null;
function $(id){ return document.getElementById(id); }
function api(p, opts){
  return fetch(APIPATH + '/api/' + p, opts).then(function(r){ return r.json(); });
}
function toast(t, ty){
  var el = $('toast');
  el.textContent = t;
  el.className = 'toast show ' + (ty || '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function(){ el.className = 'toast'; }, 2600);
}
function showMsg(id, t, ty){
  var el = $(id);
  el.textContent = t;
  el.className = 'msg show ' + (ty || 'info');
}
function copyText(t){
  var done = false;
  function fin(ok2){
    if (done) return; done = true;
    toast(ok2 ? '已复制' : '复制失败，请手动复制', ok2 ? 'ok' : 'err');
  }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    var p = null;
    try { p = navigator.clipboard.writeText(t); } catch (e) { fin(${a("ZmFsbGJhY2s=")}Copy(t)); return; }
    if (p && typeof p.then === 'function') {
      p.then(function(){ fin(true); }, function(){ fin(${a("ZmFsbGJhY2s=")}Copy(t)); });
      setTimeout(function(){ fin(${a("ZmFsbGJhY2s=")}Copy(t)); }, 600); // 剪贴板 API 悬空（无权限等）时回退
    } else { fin(true); }
  } else {
    fin(${a("ZmFsbGJhY2s=")}Copy(t));
  }
}
function ${a("ZmFsbGJhY2s=")}Copy(t){
  var ta = document.createElement('textarea');
  ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  var ok2 = false;
  try { ok2 = document.execCommand('copy'); } catch (e) { ok2 = false; }
  document.body.removeChild(ta);
  return ok2;
}
function copySub(){ copyText($('subUrl').value || makeSub()); }
function markDirty(){
  $('saveBtn').classList.add('dirty');
  $('savedAt').textContent = '有未保存的修改';
}

/* ===== 导航 ===== */
var NAV = [
  { id:'dashboard', name:'仪表盘', icon:'<path d="M4 4h7v7H4zM13 4h7v4h-7zM4 13h7v7H4zM13 11h7v9h-7z"/>' },
  { id:'warp', name:'WARP 配置', icon:'<path d="M12 3v18M5 8l7-5 7 5M5 16l7 5 7-5"/>' },
  { id:'${a("bWFzcXVl")}', name:'${a("TUFTUVVF")} 配置', icon:'<path d="M4 7l8-4 8 4v10l-8 4-8-4zM12 3v18"/>' },
  { id:'${a("aG9tZQ==")}', name:'家宽配置', icon:'<path d="M3 11l9-7 9 7M5 10v10h14V10M10 20v-6h4v6"/>' },
  { id:'nodes', name:'节点配置', icon:'<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9zM12 12l8-4.5M12 12L4 7.5"/>' },
  { id:'optimizer', name:'优选配置', icon:'<path d="M12 19a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM12 8v4l2.5 2.5M3 3l3 3"/>' },
  { id:'quota', name:'配额安全', icon:'<path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6zM9 12l2 2 4-4"/>' },
  { id:'account', name:'面板设置', icon:'<path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21c0-3.5 3.6-6 8-6s8 2.5 8 6"/>' },
  { id:'about', name:'关于项目', icon:'<path d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v5M12 8h.01"/>' }
];
var TITLES = { dashboard:'仪表盘', warp:'WARP 配置', ${a("bWFzcXVl")}:'${a("TUFTUVVF")} 配置', ${a("aG9tZQ==")}:'家宽配置', nodes:'节点配置', optimizer:'优选配置', quota:'配额安全', account:'面板设置', about:'关于项目' };

/* ===== 运行模式（四种模式互不影响，可随时切换） ===== */
var MODE_NAV = {
  worker: ['dashboard', 'nodes', 'optimizer', 'quota', 'account', 'about'],
  warp: ['dashboard', 'warp', 'account', 'about'],
  ${a("bWFzcXVl")}: ['dashboard', '${a("bWFzcXVl")}', 'account', 'about'],
  home: ['dashboard', '${a("aG9tZQ==")}', 'account', 'about']
};
var MODE_SHORT = { worker: 'Worker', warp: 'WARP', ${a("bWFzcXVl")}: '${a("TUFTUVVF")}', home: '家宽' };
var MODE_LABEL = { worker: 'Worker 模式', warp: 'WARP 模式', ${a("bWFzcXVl")}: '${a("TUFTUVVF")} 模式', home: '家宽模式' };
var MODE_DESC = {
  worker: '使用内置节点，由本服务承载转发，开箱即用。',
  warp: '下发 WARP 节点，客户端直连，流量不经过本服务。',
  ${a("bWFzcXVl")}: '下发 ${a("TUFTUVVF")} 节点，客户端直连；仅部分客户端支持。',
  home: 'VPN Gate OpenVPN 家宽出口，经隧道前置拨号（仅 ${a("TWlob21v")} 内核）。'
};
function curMode(){ var m = CFG && CFG.mode; return MODE_NAV[m] ? m : 'worker'; }
function applyMode(){
  var m = curMode(), nav = MODE_NAV[m];
  buildNav();
  var active = document.querySelector('.nav-item.on');
  if (!active || nav.indexOf(active.getAttribute('data-v')) < 0) switchView(nav[0]);
  var h = $('modeHint');
  if (h) h.innerHTML = '当前：<b>' + MODE_LABEL[m] + '</b> — ' + MODE_DESC[m];
  var sel = $('a-mode');
  if (sel) sel.value = m;
  // 地区与线路筛选只对内置 CF 节点池有意义：WARP / ${a("TUFTUVVF")} 的节点由客户端直连，不参与地区/来源筛选
  var cf = $('cardFilter');
  if (cf) cf.style.display = (m === 'worker') ? '' : 'none';
  var sm = $('stMode');
  if (sm) sm.textContent = MODE_SHORT[m] || 'Worker';
}
function exitMode(){ showMode(); }
function showMode(){ $('mMode').classList.add('show'); }
function closeMode(){ $('mMode').classList.remove('show'); }
/* ===== WARP 凭据状态与重签（自动生成，无需手填） ===== */
function setWStat(){
  var el = $('w-stat');
  if (!el) return;
  var c = null;
  try { c = JSON.parse(String(CFG.warpConf || '')); } catch (e) { c = null; }
  if (!c || !c.p || !c.a4) { el.textContent = '尚未生成 · 首次拉取订阅时会自动注册（无需任何填写）'; el.style.color = 'var(--warn)'; return; }
  var d = '';
  if (c.at) { try { d = ' · ' + new Date(c.at).toLocaleString('zh-CN'); } catch (e) { d = ''; } }
  el.textContent = '已就绪 · 内网地址 ' + String(c.a4).split('/')[0] + ' · 对端 ' + c.h + ':' + c.pt + d;
  el.style.color = 'var(--ok)';
}
function regenWarp(){
  if (!window.confirm('重新生成会作废当前凭据并重新注册，客户端需重新拉取订阅。继续？')) return;
  api('config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ warpConf: '' }) })
    .then(function(r){
      if (!r || !r.ok) { toast((r && r.msg) || '重签失败', 'err'); return; }
      CFG = r.data; setWStat(); toast('已清空凭据 · 下次拉取订阅时自动重新注册', 'ok');
    })
    .catch(function(){ toast('重签失败', 'err'); });
}
function pickMode(m){
  if (!MODE_NAV[m]) return;
  var same = (m === curMode());
  api('config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: m }) })
    .then(function(r){
      if (!r || !r.ok) { toast((r && r.msg) || '保存失败', 'err'); return; }
      CFG = r.data;
      closeMode();
      fillForm();
      renderAll();
      applyMode();
      switchView(m === 'worker' ? 'dashboard' : m);
      toast(same ? '已应用当前模式' : ('已切换到 ' + MODE_LABEL[m]), 'ok');
    })
    .catch(function(){ toast('保存失败：无法连接服务器', 'err'); });
}
function switchModeFromPanel(){
  var m = $('a-mode').value;
  if (!MODE_NAV[m]) return;
  if (m === curMode()) { toast('已是当前模式'); return; }
  if (!confirm('切换到「' + MODE_LABEL[m] + '」？\n\n' + MODE_DESC[m] + '\n\n各模式的面板形态与订阅内容会随之改变，可随时切回。')) {
    $('a-mode').value = curMode();
    return;
  }
  pickMode(m);
}
function buildNav(){
  var nav = MODE_NAV[curMode()];
  var html = '';
  NAV.forEach(function(n){
    if (nav.indexOf(n.id) < 0) return;
    html += '<button class="nav-item" data-v="' + n.id + '" onclick="switchView(\'' + n.id + '\')"><svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + n.icon + '</svg>' + n.name + '</button>';
  });
  $('nav').innerHTML = html;
}
function switchView(id){
  document.querySelectorAll('.nav-item').forEach(function(b){
    b.classList.toggle('on', b.getAttribute('data-v') === id);
  });
  document.querySelectorAll('.view').forEach(function(x){
    x.classList.toggle('on', x.getAttribute('data-view') === id);
  });
  $('pageTitle').textContent = TITLES[id] || '';
  $('sidebar').classList.remove('open');
  if (id === 'account' && typeof mdPaint === 'function') mdPaint();
}
$('hamb').addEventListener('click', function(){ $('sidebar').classList.toggle('open'); });

/* ===== Material 动态取色（移植自参考面板） ===== */
/* ---------- sRGB ↔ XYZ ↔ CAM16 ↔ HCT ---------- */
var MD_WP = [95.047, 100.0, 108.883];
var MD_XYZ2SRGB = [
  [3.2413774792388685, -1.5376652402851851, -0.49885366846268053],
  [-0.9691452513005321, 1.8758853451067872, 0.04156585616912061],
  [0.05562093689691305, -0.20395524564742123, 1.0571799111220335]
];
var MD_PI = Math.PI;
function mdClamp(a, b, x) { return x < a ? a : (x > b ? b : x); }
function mdSign(x) { return x < 0 ? -1 : (x > 0 ? 1 : 0); }
function mdDeg(d) { d = d % 360; return d < 0 ? d + 360 : d; }
var MD_LE = 216 / 24389, MD_LK = 24389 / 27;
function mdLabF(t) { return t > MD_LE ? Math.cbrt(t) : (MD_LK * t + 16) / 116; }
function mdLabInv(ft) { var f3 = ft * ft * ft; return f3 > MD_LE ? f3 : (116 * ft - 16) / MD_LK; }
function mdYFromLstar(l) { return 100 * mdLabInv((l + 16) / 116); }
function mdLstarFromY(y) { return 116 * mdLabF(y / 100) - 16; }
function mdLinear(c) { var n = c / 255; return n <= 0.040449936 ? n / 12.92 * 100 : Math.pow((n + 0.055) / 1.055, 2.4) * 100; }
function mdDelinear(c) { var n = c / 100; var d = n <= 0.0031308 ? n * 12.92 : 1.055 * Math.pow(n, 1 / 2.4) - 0.055; return mdClamp(0, 255, Math.round(d * 255)); }

/* 观看条件：D65 白点、适应亮度 11.73、背景 L*50、平均环绕，只算一次 */
var MD_VC = (function () {
  var la = (200 / MD_PI) * mdYFromLstar(50) / 100;
  var rW = MD_WP[0] * 0.401288 + MD_WP[1] * 0.650173 + MD_WP[2] * -0.051461;
  var gW = MD_WP[0] * -0.250268 + MD_WP[1] * 1.204414 + MD_WP[2] * 0.045854;
  var bW = MD_WP[0] * -0.002079 + MD_WP[1] * 0.048952 + MD_WP[2] * 0.953127;
  var f = 1.0, cc = 0.69;
  var d = mdClamp(0, 1, f * (1 - (1 / 3.6) * Math.exp((-la - 42) / 92)));
  var rgbD = [d * (100 / rW) + 1 - d, d * (100 / gW) + 1 - d, d * (100 / bW) + 1 - d];
  var k = 1 / (5 * la + 1), k4 = k * k * k * k, k4F = 1 - k4;
  var fl = k4 * la + 0.1 * k4F * k4F * Math.cbrt(5 * la);
  var n = mdYFromLstar(50) / MD_WP[1];
  var z = 1.48 + Math.sqrt(n);
  var nbb = 0.725 / Math.pow(n, 0.2);
  var af = [Math.pow(fl * rgbD[0] * rW / 100, 0.42), Math.pow(fl * rgbD[1] * gW / 100, 0.42), Math.pow(fl * rgbD[2] * bW / 100, 0.42)];
  var aa = [400 * af[0] / (af[0] + 27.13), 400 * af[1] / (af[1] + 27.13), 400 * af[2] / (af[2] + 27.13)];
  return { n: n, aw: (2 * aa[0] + aa[1] + 0.05 * aa[2]) * nbb, nbb: nbb, ncb: nbb, c: cc, nc: f, rgbD: rgbD, fl: fl, fLRoot: Math.pow(fl, 0.25), z: z };
})();

/* 正向：8 位 sRGB → { h 色相, c 色度, t 色调 } */
function mdHctFromRgb(r, g, b) {
  var rl = mdLinear(r), gl = mdLinear(g), bl = mdLinear(b);
  var x = 0.41233895 * rl + 0.35762064 * gl + 0.18051042 * bl;
  var y = 0.2126 * rl + 0.7152 * gl + 0.0722 * bl;
  var z = 0.01932141 * rl + 0.11916382 * gl + 0.95034478 * bl;
  var rC = 0.401288 * x + 0.650173 * y - 0.051461 * z;
  var gC = -0.250268 * x + 1.204414 * y + 0.045854 * z;
  var bC = -0.002079 * x + 0.048952 * y + 0.953127 * z;
  var rD = MD_VC.rgbD[0] * rC, gD = MD_VC.rgbD[1] * gC, bD = MD_VC.rgbD[2] * bC;
  var rAF = Math.pow(MD_VC.fl * Math.abs(rD) / 100, 0.42);
  var gAF = Math.pow(MD_VC.fl * Math.abs(gD) / 100, 0.42);
  var bAF = Math.pow(MD_VC.fl * Math.abs(bD) / 100, 0.42);
  var rA = mdSign(rD) * 400 * rAF / (rAF + 27.13);
  var gA = mdSign(gD) * 400 * gAF / (gAF + 27.13);
  var bA = mdSign(bD) * 400 * bAF / (bAF + 27.13);
  var a = (11 * rA - 12 * gA + bA) / 11;
  var bb = (rA + gA - 2 * bA) / 9;
  var u = (20 * rA + 20 * gA + 21 * bA) / 20;
  var p2 = (40 * rA + 20 * gA + bA) / 20;
  var hue = mdDeg(Math.atan2(bb, a) * 180 / MD_PI);
  var J = 100 * Math.pow(p2 * MD_VC.nbb / MD_VC.aw, MD_VC.c * MD_VC.z);
  var hp = hue < 20.14 ? hue + 360 : hue;
  var eHue = 0.25 * (Math.cos(hp * MD_PI / 180 + 2) + 3.8);
  var p1 = (50000 / 13) * eHue * MD_VC.nc * MD_VC.ncb;
  var t = (p1 * Math.sqrt(a * a + bb * bb)) / (u + 0.305);
  var alpha = Math.pow(t, 0.9) * Math.pow(1.64 - Math.pow(0.29, MD_VC.n), 0.73);
  return { h: hue, c: alpha * Math.sqrt(J / 100), t: mdLstarFromY(y) };
}

/* 逆向：CAM16 (J, C, H) → 线性 sRGB（未裁剪，用于色域判定） */
function mdCamToLinear(j, c, h) {
  var alpha = (c === 0 || j === 0) ? 0 : c / Math.sqrt(j / 100);
  var t = Math.pow(alpha / Math.pow(1.64 - Math.pow(0.29, MD_VC.n), 0.73), 1 / 0.9);
  var hRad = h * MD_PI / 180;
  var eHue = 0.25 * (Math.cos(hRad + 2) + 3.8);
  var ac = MD_VC.aw * Math.pow(j / 100, 1 / MD_VC.c / MD_VC.z);
  var p1 = eHue * (50000 / 13) * MD_VC.nc * MD_VC.ncb;
  var p2 = ac / MD_VC.nbb;
  var hSin = Math.sin(hRad), hCos = Math.cos(hRad);
  var gamma = (23 * (p2 + 0.305) * t) / (23 * p1 + 11 * t * hCos + 108 * t * hSin);
  var a = gamma * hCos, b = gamma * hSin;
  var rA = (460 * p2 + 451 * a + 288 * b) / 1403;
  var gA = (460 * p2 - 891 * a - 261 * b) / 1403;
  var bA = (460 * p2 - 220 * a - 6300 * b) / 1403;
  var rB = Math.max(0, 27.13 * Math.abs(rA) / (400 - Math.abs(rA)));
  var gB = Math.max(0, 27.13 * Math.abs(gA) / (400 - Math.abs(gA)));
  var bB = Math.max(0, 27.13 * Math.abs(bA) / (400 - Math.abs(bA)));
  var rC = mdSign(rA) * (100 / MD_VC.fl) * Math.pow(rB, 1 / 0.42);
  var gC = mdSign(gA) * (100 / MD_VC.fl) * Math.pow(gB, 1 / 0.42);
  var bC = mdSign(bA) * (100 / MD_VC.fl) * Math.pow(bB, 1 / 0.42);
  var rF = rC / MD_VC.rgbD[0], gF = gC / MD_VC.rgbD[1], bF = bC / MD_VC.rgbD[2];
  var X = 1.86206786 * rF - 1.01125463 * gF + 0.14918677 * bF;
  var Y = 0.38752654 * rF + 0.62144744 * gF - 0.00897398 * bF;
  var Z = -0.01584150 * rF - 0.03412294 * gF + 1.04996444 * bF;
  return [
    MD_XYZ2SRGB[0][0] * X + MD_XYZ2SRGB[0][1] * Y + MD_XYZ2SRGB[0][2] * Z,
    MD_XYZ2SRGB[1][0] * X + MD_XYZ2SRGB[1][1] * Y + MD_XYZ2SRGB[1][2] * Z,
    MD_XYZ2SRGB[2][0] * X + MD_XYZ2SRGB[2][1] * Y + MD_XYZ2SRGB[2][2] * Z
  ];
}
function mdInGamut(v) {
  return v[0] >= -0.01 && v[0] <= 100.01 && v[1] >= -0.01 && v[1] <= 100.01 && v[2] >= -0.01 && v[2] <= 100.01;
}
function mdLinToRgb(v) { return [mdDelinear(v[0]), mdDelinear(v[1]), mdDelinear(v[2])]; }

/* 求出让量化后色调等于 tone 的 CAM16 明度 J */
function mdJForTone(h, c, tone) {
  var lo = 0.01, hi = 99.9, i, mid, rgb, lt;
  for (i = 0; i < 24; i++) {
    mid = (lo + hi) / 2;
    rgb = mdLinToRgb(mdCamToLinear(mid, c, h));
    lt = mdLstarFromY(mdLinear(rgb[0]) * 0.2126 + mdLinear(rgb[1]) * 0.7152 + mdLinear(rgb[2]) * 0.0722);
    if (lt < tone) { lo = mid; } else { hi = mid; }
  }
  return (lo + hi) / 2;
}
/* HCT → sRGB：先把色度收敛到色域内（保住色调、牺牲色度），再解明度 */
function mdRgbFromHct(hue, chroma, tone) {
  var h = mdDeg(hue), t = mdClamp(0, 100, tone);
  if (!(chroma >= 1e-4) || t >= 99.9999 || t <= 0.0001) {
    var g = mdDelinear(mdYFromLstar(t));
    return [g, g, g];
  }
  var lo = 0, hi = chroma, i, mid;
  for (i = 0; i < 16; i++) {
    mid = (lo + hi) / 2;
    if (mdInGamut(mdCamToLinear(mdJForTone(h, mid, t), mid, h))) { lo = mid; } else { hi = mid; }
  }
  if (lo < 1e-4) { var g2 = mdDelinear(mdYFromLstar(t)); return [g2, g2, g2]; }
  return mdLinToRgb(mdCamToLinear(mdJForTone(h, lo, t), lo, h));
}

/* ---------- 十六进制互转 ---------- */
function mdHexToRgb(hx) {
  var s = String(hx || '').replace(/[^0-9a-fA-F]/g, '');
  if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
  if (s.length !== 6) return null;
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
}
function mdRgbToHex(v) {
  return '#' + v.map(function (x) { var s = mdClamp(0, 255, Math.round(x)).toString(16); return s.length < 2 ? '0' + s : s; }).join('');
}
function mdHctFromHex(hx) { var v = mdHexToRgb(hx); return v ? mdHctFromRgb(v[0], v[1], v[2]) : { h: 0, c: 0, t: 50 }; }
function mdHexFromHct(h, c, t) { return mdRgbToHex(mdRgbFromHct(h, c, t)); }

/* ---------- 色调与主题方案 ---------- */
/* 文档的 13 个色调标号 0/10/50/100/200…1000 ↔ HCT 色调 100/99/95/90/80…0 */
var MD_TONE_LABELS = [0, 10, 50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];
function mdLabelToTone(L) { return (1000 - L) / 10; }
var MD_TONES = MD_TONE_LABELS.map(mdLabelToTone);

/* 主题方案：hue 为各调色盘相对来源色的色相偏移，chroma 为色度，
   n 为 neutral1/neutral2 色度，cap 为高色调（≥90）的色度上限。
   TONAL_SPOT 完全按文档：accent1 色度 48、高色调 40；accent2 16；accent3 色相 +60、色度 32；
   neutral1 色度 4；neutral2 色度 8。 */
var MD_VARIANTS = [
  { id: 'TONAL_SPOT', name: '色调点', desc: 'Android 默认方案，低到中等彩度', hue: [0, 0, 60], chroma: [48, 16, 32], n: [4, 8], cap: 40 },
  { id: 'VIBRANT', name: '鲜艳', desc: '次色与三色与主色同类，整体更饱和', hue: [0, 0, 60], chroma: [64, 32, 48], n: [6, 10], cap: 40 },
  { id: 'EXPRESSIVE', name: '表现力', desc: '高彩度，色相间拉开距离', hue: [0, 15, -45], chroma: [72, 36, 56], n: [8, 12], cap: 44 },
  { id: 'SPRITZ', name: '灰调', desc: '去饱和，接近灰阶', hue: [0, 0, 60], chroma: [14, 8, 18], n: [3, 5], cap: 14 }
];
function mdVariant(id) {
  for (var i = 0; i < MD_VARIANTS.length; i++) { if (MD_VARIANTS[i].id === id) return MD_VARIANTS[i]; }
  return MD_VARIANTS[0];
}

/* ---------- 由来源色派生 5 个色调调色盘 ---------- */
function mdPalettes(seedHex, variantId) {
  var src = mdHctFromHex(seedHex);
  /* 文档要求来源色的 CAM16 色度不低于 5，否则色相不稳 */
  var hue = src.h, chroma = Math.max(5, src.c);
  var V = mdVariant(variantId);
  var cap = function (c, t) { return t >= 90 ? Math.min(c, V.cap) : c; };
  var P = {
    a1: { h: hue, c: V.chroma[0] },
    a2: { h: mdDeg(hue + V.hue[1]), c: V.chroma[1] },
    a3: { h: mdDeg(hue + V.hue[2]), c: V.chroma[2] },
    n1: { h: hue, c: V.n[0] },
    n2: { h: hue, c: V.n[1] },
    err: { h: 25, c: 84 }
  };
  for (var k in P) { P[k].at = function (t) { return mdHexFromHct(this.h, cap(this.c, t), t); }; }
  P.err.at = function (t) { return mdHexFromHct(this.h, this.c, t); };
  P.seed = seedHex;
  P.sourceChroma = chroma;
  return P;
}
/* 65 色：5 个调色盘 × 13 个色调，键为文档标号 */
function mdTonal(seedHex, variantId) {
  var P = mdPalettes(seedHex, variantId);
  var out = {};
  ['a1', 'a2', 'a3', 'n1', 'n2'].forEach(function (k) {
    var row = {};
    MD_TONE_LABELS.forEach(function (L) { row[L] = P[k].at(mdLabelToTone(L)); });
    out[k] = row;
  });
  return out;
}

/* ---------- 颜色角色映射（文档「Material 库颜色属性更新」表） ---------- */
/* [角色, 调色盘, 浅色主题色调, 深色主题色调] —— 标号 N ↔ 色调 (1000-N)/10 */
var MD_ROLE_MAP = [
  ['primary', 'a1', 600, 200], ['onPrimary', 'a1', 0, 800],
  ['primaryContainer', 'a1', 100, 700], ['onPrimaryContainer', 'a1', 900, 900],
  ['secondary', 'a2', 600, 200], ['onSecondary', 'a2', 0, 800],
  ['secondaryContainer', 'a2', 100, 700], ['onSecondaryContainer', 'a2', 900, 900],
  ['tertiary', 'a3', 600, 200], ['onTertiary', 'a3', 0, 800],
  ['tertiaryContainer', 'a3', 100, 700], ['onTertiaryContainer', 'a3', 900, 900],
  ['error', 'err', 600, 200], ['onError', 'err', 0, 800],
  ['errorContainer', 'err', 100, 700], ['onErrorContainer', 'err', 900, 900],
  ['background', 'n1', 10, 900],
  ['onBackground', 'n1', 900, 100],
  ['surface', 'n1', 10, 900], ['onSurface', 'n1', 900, 100],
  ['surfaceContainerLowest', 'n1', 0, 1000], ['surfaceContainerLow', 'n1', 100, 900],
  ['surfaceContainer', 'n1', 200, 800], ['surfaceContainerHigh', 'n1', 300, 700],
  ['surfaceContainerHighest', 'n1', 400, 600],
  ['surfaceVariant', 'n2', 100, 700], ['onSurfaceVariant', 'n2', 700, 200],
  ['outline', 'n2', 500, 400], ['outlineVariant', 'n2', 200, 700],
  ['inverseSurface', 'n1', 800, 100], ['inverseOnSurface', 'n1', 100, 800],
  ['inversePrimary', 'a1', 200, 600],
  /* 遮罩与投影不随深浅翻转：M3 规定两者在任何主题下都是纯黑 */
  ['scrim', 'n1', 1000, 1000], ['shadow', 'n1', 1000, 1000],
  /* 状态层与状态内容（文档第二张表） */
  ['primaryStateContent', 'a1', 700, 200], ['primaryStateLayer', 'a1', 600, 300],
  ['secondaryStateContent', 'a2', 700, 200], ['secondaryStateLayer', 'a2', 600, 300],
  ['onPrimaryStateContent', 'a1', 0, 800], ['onPrimaryStateLayer', 'a1', 900, 800],
  ['onSecondaryStateContent', 'a2', 0, 800], ['onSecondaryStateLayer', 'a2', 900, 800],
  ['onSurfaceStateContent', 'n1', 900, 100], ['onSurfaceStateLayer', 'n1', 900, 100],
  ['onSurfaceVariantStateContent', 'n2', 700, 200], ['onSurfaceVariantStateLayer', 'n2', 700, 200],
  ['errorStateContent', 'err', 800, 200]
];
function mdRoleKey(role) {
  return role.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}
/* 生成整套颜色角色；dark 为真时取深色主题列 */
function mdRoles(seedHex, variantId, dark) {
  var P = mdPalettes(seedHex, variantId);
  var out = {};
  MD_ROLE_MAP.forEach(function (row) {
    var pal = P[row[1]], L = dark ? row[3] : row[2];
    out[row[0]] = pal.at(mdLabelToTone(L));
  });
  return out;
}
/* 把角色写成 CSS 变量 */
function mdApply(seedHex, variantId, dark) {
  var r = mdRoles(seedHex, variantId, dark);
  var st = document.documentElement.style;
  for (var k in r) { st.setProperty('--m-' + mdRoleKey(k), r[k]); }
  return r;
}

/* ---------- Material 外观 ---------- */
var MD_SEED_DEF = '#6750A4';
var MD_PNAME = { a1: 'accent1', a2: 'accent2', a3: 'accent3', n1: 'neutral1', n2: 'neutral2' };
function storedStyle(){ try { return localStorage.getItem('nb_style') || 'glass'; } catch (e) { return 'glass'; } }
function storedSeed(){
  try { var v = localStorage.getItem('nb_seed'); return (v && mdHexToRgb(v)) ? v : MD_SEED_DEF; } catch (e) { return MD_SEED_DEF; }
}
function storedVariant(){ try { return localStorage.getItem('nb_variant') || 'TONAL_SPOT'; } catch (e) { return 'TONAL_SPOT'; } }
function savePref(k, v){ try { localStorage.setItem(k, v); } catch (e) {} }
function normHex(hx){ var v = mdHexToRgb(hx); return v ? mdRgbToHex(v) : null; }

/* 派生 65 色角色写入 CSS 变量；变量就绪后才挂 data-style，避免首帧闪烁 */
function mdSync(){
  var roles = mdApply(storedSeed(), storedVariant(), resolveTheme(storedTheme()) !== 'light');
  document.documentElement.setAttribute('data-style', storedStyle());
  return roles;
}
function setStyle(s){ savePref('nb_style', s); mdSync(); mdPaint(); }
function setSeed(hx){
  var v = normHex(hx); if (!v) return false;
  savePref('nb_seed', v); mdSync(); mdPaint(); return true;
}
function setVariant(id){ savePref('nb_variant', id); mdSync(); mdPaint(); }
function resetSeed(){ var i = $('mdSeed'); var s = setSeed(MD_SEED_DEF); if (i) i.value = storedSeed(); return s; }

/* ---------- 外观风格：色彩设置折叠（从「种子色」起收起） ---------- */
function mdFoldSet(open){
  var b = $('mdFoldBtn'), d = $('mdBox');
  if (!b || !d) return;
  d.classList[open ? 'add' : 'remove']('open');
  b.setAttribute('data-open', open ? '1' : '0');
  b.title = open ? '收起色彩设置' : '展开色彩设置';
}
function mdFoldInit(){
  var open = false;
  try { open = localStorage.getItem('nb_mdfold') === '1'; } catch (e) {}
  mdFoldSet(open);
}
function toggleMdFold(){
  var b = $('mdFoldBtn');
  var open = !(b && b.getAttribute('data-open') === '1');
  try { localStorage.setItem('nb_mdfold', open ? '1' : '0'); } catch (e) {}
  mdFoldSet(open);
  if (open && typeof mdPaint === 'function') mdPaint();
}

function buildOnce(el, html){
  if (!el || el.getAttribute('data-built')) return;
  el.innerHTML = html; el.setAttribute('data-built', '1');
}
/* 渲染外观卡片：风格段选、种子色板、方案段选、65 色预览 */
function mdPaint(){
  var seed = storedSeed(), variant = storedVariant(), style = storedStyle();
  var seg = document.querySelectorAll('#styleSeg button');
  for (var i = 0; i < seg.length; i++) seg[i].classList.toggle('on', seg[i].getAttribute('data-s') === style);

  var sr = $('mdSeedRow');
  if (sr) {
    buildOnce(sr, ["#6750A4","#0B57D0","#006A6A","#006E1C","#7A5900","#8B5000","#BA1A1A","#B90063","#7C6CFF","#5F6368"].map(function (c) {
      return '<i data-c="' + c + '" style="background:' + c + '" title="' + c + '"></i>';
    }).join(''));
    var its = sr.querySelectorAll('i');
    for (var j = 0; j < its.length; j++) {
      its[j].classList.toggle('on', normHex(its[j].getAttribute('data-c')) === normHex(seed));
    }
    if (!sr.getAttribute('data-bound')) {
      sr.setAttribute('data-bound', '1');
      sr.addEventListener('click', function (e) {
        var t = e.target;
        if (t && t.tagName === 'I') { var c = t.getAttribute('data-c'); var inp = $('mdSeed'); if (inp) inp.value = c; setSeed(c); }
      });
    }
  }
  var vs = $('mdVarSeg');
  if (vs) {
    buildOnce(vs, MD_VARIANTS.map(function (v) {
      return '<button class="btn sm" data-v="' + v.id + '" onclick="setVariant(\'' + v.id + '\')">' + v.name + '</button>';
    }).join(''));
    var vb = vs.querySelectorAll('button');
    for (var m = 0; m < vb.length; m++) vb[m].classList.toggle('on', vb[m].getAttribute('data-v') === variant);
  }
  var dsc = $('mdVarDesc');
  if (dsc) dsc.textContent = mdVariant(variant).desc;

  var pal = $('mdPal');
  if (pal) {
    buildOnce(pal, ['a1', 'a2', 'a3', 'n1', 'n2'].map(function (row) {
      return '<div class="r"><b>' + MD_PNAME[row] + '</b>' + MD_TONE_LABELS.map(function (L) {
        return '<i data-p="' + row + '" data-l="' + L + '"></i>';
      }).join('') + '</div>';
    }).join(''));
    var T = mdTonal(seed, variant);
    var cells = pal.querySelectorAll('i');
    var srgb = mdHexToRgb(seed), best = null, bestD = 1e9;
    for (var n = 0; n < cells.length; n++) {
      var cp = cells[n].getAttribute('data-p'), cl = cells[n].getAttribute('data-l');
      var hx = T[cp][cl], c = mdHexToRgb(hx);
      cells[n].style.background = hx;
      cells[n].setAttribute('data-hex', hx);
      cells[n].title = MD_PNAME[cp] + ' · ' + cl + ' · ' + hx + '\n单击设为种子色';
      cells[n].classList.remove('on');
      var d = Math.abs(c[0] - srgb[0]) + Math.abs(c[1] - srgb[1]) + Math.abs(c[2] - srgb[2]);
      if (d < bestD) { bestD = d; best = cells[n]; }   /* 种子色在色板中的落点 */
    }
    if (best) best.classList.add('on');
    /* 单击任一色块 → 该色成为新的种子色（与上方预设色板同一套交互） */
    if (!pal.getAttribute('data-bound')) {
      pal.setAttribute('data-bound', '1');
      pal.addEventListener('click', function (e) {
        var t = e.target;
        if (!t || t.tagName !== 'I') return;
        var hx = t.getAttribute('data-hex');
        if (!hx || !mdHexToRgb(hx)) return;
        if (normHex(hx) === normHex(storedSeed())) { toast('已是当前种子色 ' + hx); return; }
        var i = $('mdSeed'); if (i) i.value = hx;
        setSeed(hx);
        toast('种子色已更新 · ' + hx);
      });
    }
  }
  var po = $('mdPalOut');
  if (po) {
    var found = null;
    if (pal) {
      var cs = pal.querySelectorAll('i');
      for (var k = 0; k < cs.length; k++) if (cs[k].classList.contains('on')) { found = cs[k]; break; }
    }
    po.innerHTML = '<i class="chip" style="background:' + seed + '"></i>' +
      '<span class="hx" title="点击复制" onclick="copySeed()">' + seed + '</span>' +
      '<span class="tag">当前种子色' + (found
        ? ' · 落点 ' + MD_PNAME[found.getAttribute('data-p')] + ' · ' + found.getAttribute('data-l')
        : '') + '　单击色块即可改用该色</span>';
  }
  var inp = $('mdSeed');
  if (inp && document.activeElement !== inp) inp.value = seed;
}

/* 复制当前种子色 */
function copySeed(){ copyText(storedSeed()); }

/* ---------- 涟漪（Material 触控反馈） ---------- */
function mdRipple(e){
  if (storedStyle() !== 'material') return;
  if (!e.target || !e.target.closest) return;
  var host = e.target.closest('.btn,.ibtn,.nav-item,.sp span,.pill,.fgrp');
  if (!host) return;
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  var r = host.getBoundingClientRect();
  if (!r.width || !r.height) return;
  var d = Math.max(r.width, r.height) * 2;
  var sp = document.createElement('span');
  sp.className = 'md-rip';
  sp.style.width = sp.style.height = d + 'px';
  sp.style.left = (e.clientX - r.left - d / 2) + 'px';
  sp.style.top = (e.clientY - r.top - d / 2) + 'px';
  host.appendChild(sp);
  setTimeout(function () { if (sp.parentNode) sp.parentNode.removeChild(sp); }, 640);
}

/* ===== 主题 ===== */
function systemIsLight(){ return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches; }
function storedTheme(){ var t = 'dark'; try { t = localStorage.getItem('tp_theme') || 'dark'; } catch(e) {} return t; }
function resolveTheme(t){ if (t === 'auto') return systemIsLight() ? 'light' : 'dark'; return t; }
function setThemeIcon(t){
  var p = document.getElementById('themeIcon');
  if (!p) return;
  if (t === 'light') p.setAttribute('d', 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4');
  else p.setAttribute('d', 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z');
}
function applyTheme(){
  var t = resolveTheme(storedTheme());
  document.documentElement.setAttribute('data-theme', t);
  setThemeIcon(t);
  if (typeof mdSync === 'function') mdSync();
}
function setTheme(t){
  try { localStorage.setItem('tp_theme', t); } catch(e) {}
  applyTheme();
  toast(t === 'auto' ? '已切换为跟随系统' : (t === 'light' ? '已切换为日间模式' : '已切换为夜间模式'), 'ok');
}
$('themeBtn').addEventListener('click', function(){
  var cur = storedTheme();
  var next = (cur === 'light') ? 'dark' : 'light';
  setTheme(next);
});
applyTheme();
if (typeof mdFoldInit === 'function') mdFoldInit();

/* ===== 更新检测 ===== */
var topVerText = 'v—';
function legacyCopy(t){
  try {
    var ta = document.createElement('textarea');
    ta.value = t;
    ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    var ok2 = false;
    try { ok2 = document.execCommand('copy'); } catch (e) { ok2 = false; }
    document.body.removeChild(ta);
    return ok2;
  } catch (e) { return false; }
}
function copyClipboard(t){
  return new Promise(function(ok){
    var done = false;
    function finish(v){ if (done) return; done = true; ok(v); }
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        var p = null;
        try { p = navigator.clipboard.writeText(t); } catch (e) { finish(legacyCopy(t)); return; }
        if (p && typeof p.then === 'function') {
          p.then(function(){ finish(true); }, function(){ finish(legacyCopy(t)); });
          setTimeout(function(){ finish(legacyCopy(t)); }, 600); // 剪贴板 API 悬空（无权限等）时回退
        } else { finish(true); }
      } else {
        finish(legacyCopy(t));
      }
    } catch (e) { finish(legacyCopy(t)); }
  });
}
function checkUpdate(){
  var sv = $('sideVer');
  if (sv.classList.contains('checking')) return;
  sv.classList.add('checking');
  sv.textContent = '检测中…';
  api('update').then(function(r){
    sv.classList.remove('checking');
    if (!r || !r.ok || !r.data) { sv.textContent = topVerText; toast('检测更新失败，请稍后重试', 'err'); return; }
    var d = r.data;
    var kindName = (d.kind === '小说混淆') ? '小说混淆版' : (d.kind === '混淆') ? '混淆版' : '明文版';
    topVerText = 'v' + d.current + ' ' + kindName;
    sv.textContent = topVerText;
    if (d.hasUpdate && d.code) {
      sv.classList.add('has-update');
      var kind = (d.kind === '小说混淆') ? '小说混淆' : (d.kind === '混淆') ? '混淆' : '明文';
      copyClipboard(d.code).then(function(copied){
        toast(copied ? '检测到更新，已复制最新' + kind + '代码到剪贴板' : '检测到更新（v' + d.latest + '），复制失败，请前往仓库获取', copied ? 'ok' : 'err');
      });
    } else if (d.hasUpdate) {
      toast('检测到更新（v' + d.latest + '），但未能获取代码', 'err');
    } else if (d.latest) {
      sv.classList.remove('has-update');
      toast('已是最新版本（v' + d.current + ' ' + kindName + '）', 'ok');
    } else {
      toast('检测更新失败：' + (d.error || '仓库暂不可达'), 'err');
    }
  }).catch(function(){
    sv.classList.remove('checking');
    sv.textContent = topVerText;
    toast('检测更新失败，请稍后重试', 'err');
  });
}

/* ===== 配置加载与回填 ===== */
function loadAll(){
  updateFreeDomainWarn();
  api('status').then(function(r){
    if (r && r.ok) renderStatus(r.data);
  }).catch(function(){});
  api('config').then(function(r){
    if (r && r.ok){
      CFG = r.data;
      fillForm();
      renderAll();
      applyMode();
      if (!CFG.mode) showMode();
      makeSub(false);
      setConn(true);
      refreshQuota();
      toast('配置已加载', 'ok');
    } else if (r && r.status === 403) {
      location.reload();
    } else {
      setConn(false);
      toast('无法连接服务器', 'err');
    }
  }).catch(function(){
    setConn(false);
    toast('无法连接服务器', 'err');
  });
}
function setConn(ok){
  var p = $('connPill');
  p.className = 'pill ' + (ok ? '' : 'off');
  $('connText').textContent = ok ? '运行中' : '无法连接';
}
// 免费域名（*.workers.dev / *.pages.dev）大陆直连被阻断：命中即提示绑定自定义域名
function isFreeSubDomain(h){
  return /\.(workers\.dev|pages\.dev)$/i.test(String(h || ''));
}
function updateFreeDomainWarn(){
  var effHost = (CFG && CFG.host) ? String(CFG.host) : location.hostname;
  var wd = isFreeSubDomain(location.hostname) || isFreeSubDomain(effHost);
  // Pages 部署（*.pages.dev）不展示那条 *.workers.dev 横幅：域名与文案不符
  var isPages = /\.pages\.dev$/i.test(String(location.hostname || ''));
  $('wdwarn').style.display = wd && !isPages ? 'block' : 'none';
  $('subHint').textContent = wd
    ? '节点 SNI / 订阅域名使用 *.pages.dev 或 *.workers.dev 免费域名：大陆直连会被阻断——订阅导入与更新需挂梯子，节点测延迟与连接可能全部失败。解决：在 Cloudflare 控制台为本项目绑定自定义域名，再用自定义域名打开面板重新复制订阅链接。'
    : '';
}
function renderStatus(d){
  $('stEntry').textContent = location.origin + '/' + (d.path || d.uuid || '');
  updateFreeDomainWarn();
  var kv = d.kv;
  var kvTxt = kv ? '已绑定（配置持久化）' : '未绑定（配置仅内存）';
  $('stKv').textContent = kvTxt;
  $('stKv').className = 'v ' + (kv ? 'ok' : 'bad');
  $('aKv').textContent = kvTxt;
  $('aKv').className = 'v ' + (kv ? 'ok' : 'bad');
  var v = d.version || '—';
  var kindName = (d.kind === '小说混淆版') ? '小说混淆版' : (d.kind === '混淆版') ? '混淆版' : '明文版';   // 部署形态（明文版 / 混淆版 / 小说混淆版），由后端自检
  $('sideVer').textContent = 'v' + v + ' ' + kindName;
  topVerText = 'v' + v + ' ' + kindName;
  $('aVer').textContent = v + ' ' + kindName;
}
function protoText(){
  if (!CFG) return '—';
  var a = [];
  if (CFG.enable${a("Vmxlc3M=")} !== false) a.push('${a("VkxFU1M=")}');
  if (CFG.enable${a("VHJvamFu")}) a.push('${a("VHJvamFu")}');
  if (CFG.enable${a("WGh0dHA=")}) a.push('${a("WEhUVFA=")}');
  return a.length ? a.join(' / ') : '未启用';
}
function renderAll(){
  $('stProto').textContent = protoText();
  renderQuota();
}
function renderQuota(){
  var nl = !!(CFG && CFG.nodeLimit);
  $('qNl').textContent = nl ? '已开启' : '关闭（默认分档上限）';
  $('qNl').className = 'v ' + (nl ? 'ok' : '');
  $('qNlCount').textContent = nl ? (CFG.nodeLimitCount || 300) + ' 节点' : '—';
  var pc = !!(CFG && CFG.cpuLimit);
  $('qCpuLimit').textContent = pc ? '已开启（降载下发，按上限 60% 下发）' : '关闭（按设定数量完整下发）';
  $('qCpuLimit').className = 'v ' + (pc ? 'ok' : '');
  var lb = !(CFG && CFG.loadBalance === false);
  $('qLb').textContent = lb ? '已开启（随机轮换）' : '关闭（固定顺序）';
  $('qLb').className = 'v ' + (lb ? 'ok' : 'ok');
  // IPv6 下发策略：'full'（旧行为）标黄提醒——v6 备胎会拖慢客户端逐节点测延迟
  var i6 = (CFG && CFG.ipv6Mode) || 'off';
  $('qIp6').textContent = i6 === 'full' ? '等权混合（旧行为）' : (i6 === 'tail' ? '仅备胎（≤10%，排尾部）' : '不下发');
  $('qIp6').className = 'v ' + (i6 === 'full' ? 'warn' : 'ok');
}
function fmtNum(n){
  if (n == null || isNaN(n)) return '—';
  n = Number(n);
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(n);
}
function showQuotaState(kind, text){
  $('qQuotaWrap').style.display = (kind === 'data') ? '' : 'none';
  $('qQuotaEmpty').style.display = (kind === 'empty') ? '' : 'none';
  $('qQuotaErr').style.display = (kind === 'err') ? '' : 'none';
  if (kind === 'err') $('qQuotaErrText').textContent = quotaErrText(text);
  if (kind === 'data'){ $('qQuotaEmpty').style.display = 'none'; }
}
function quotaErrText(e){
  var m = String(e || '');
  if (m.indexOf('401') >= 0) return '认证失败（CF API 401）：请检查账户 ID 是否为 32 位十六进制、API 令牌是否有效且勾选 Account Analytics 读取权限';
  if (m.indexOf('403') >= 0) return '无权限（CF API 403）：API 令牌缺少账户 Analytics 读取权限';
  if (m.indexOf('429') >= 0) return 'CF API 限流（429）：已自动退避 15 分钟，期间沿用缓存数据';
  if (m.indexOf('未找到账户') >= 0) return m + '：请核对 dash.cloudflare.com 右侧栏的 32 位账户 ID';
  return m || '用量查询失败';
}
function renderQuotaData(d){
  updDbQuota(d);
  if (!d || !d.configured){
    $('qQuotaSub').textContent = '未配置';
    showQuotaState('empty');
    return;
  }
  if (d.error && !d.stale){
    $('qQuotaSub').textContent = '查询失败';
    showQuotaState('err', d.error);
    return;
  }
  $('qQuotaSub').textContent = d.stale ? '缓存数据' : '已连接';
  showQuotaState('data');
  $('qReq').textContent = fmtNum(d.today.requests) + ' / ' + fmtNum(d.limit);
  var p = d.percent || 0;
  $('qBar').style.width = Math.min(100, p) + '%';
  $('qBar').style.background = p >= 90 ? 'linear-gradient(90deg,var(--err),var(--warn))' : (p >= 60 ? 'linear-gradient(90deg,var(--warn),var(--accent))' : 'linear-gradient(90deg,var(--ok),var(--accent))');
  $('qPct').textContent = p + '%';
  $('qPct').className = 'v ' + (p >= 90 ? 'bad' : (p >= 60 ? '' : 'ok'));
  $('qRemain').textContent = fmtNum(d.remaining != null ? d.remaining : (d.limit - d.today.requests));
  $('qCpu').textContent = (d.today.cpuTime != null) ? (d.today.cpuTime / 1000).toFixed(2) + ' s' : '—';
  $('qSub').textContent = fmtNum(d.today.subrequests);
  $('qAt').textContent = (d.updatedAt ? String(d.updatedAt).replace('T', ' ').replace('Z', '') + ' UTC' : '—') + (d.stale ? '（限流缓存）' : '');
}
function updDbQuota(d){
  if (!d || !d.configured){ $('dbSub').textContent = '未配置监控'; $('dbWrap').style.display = 'none'; return; }
  if (d.error && !d.stale){ $('dbSub').textContent = '查询失败'; $('dbWrap').style.display = 'none'; return; }
  $('dbSub').textContent = d.stale ? '缓存数据' : '已连接';
  $('dbWrap').style.display = '';
  $('dbReq').textContent = fmtNum(d.today.requests) + ' / ' + fmtNum(d.limit);
  var p = d.percent || 0;
  $('dbBar').style.width = Math.min(100, p) + '%';
  $('dbBar').style.background = p >= 90 ? 'linear-gradient(90deg,var(--err),var(--warn))' : (p >= 60 ? 'linear-gradient(90deg,var(--warn),var(--accent))' : 'linear-gradient(90deg,var(--ok),var(--accent))');
  $('dbPct').textContent = p + '%';
  $('dbPct').className = 'v ' + (p >= 90 ? 'bad' : (p >= 60 ? '' : 'ok'));
}
function refreshQuota(){
  $('qQuotaSub').textContent = '查询中…';
  api('quota').then(function(r){
    if (r && r.ok) renderQuotaData(r.data);
    else { $('qQuotaSub').textContent = '查询失败'; showQuotaState('err', (r && r.msg) || '查询失败'); }
  }).catch(function(){ $('qQuotaSub').textContent = '查询失败'; showQuotaState('err', '无法连接服务器'); });
}
function parseIps(t){
  var out = [];
  String(t || '').split(/[\n,;]+/).map(function(s){ return s.trim(); }).filter(Boolean).forEach(function(s){
    var name = '';
    if (s.indexOf('#') >= 0){ var a = s.split('#'); s = a[0]; name = a[1]; }
    var m;
    if ((m = s.match(/^\[([0-9a-fA-F:]+)\](?::(\d+))?$/))){ out.push({ ip: m[1], port: parseInt(m[2]) || 443, name: name }); return; }
    if ((m = s.match(/^(\d+\.\d+\.\d+\.\d+)(?::(\d+))?$/))){ out.push({ ip: m[1], port: parseInt(m[2]) || 443, name: name }); }
  });
  return out;
}
function renderPreferred(){
  if (!CFG) return;
  var lines = [];
  String(CFG.preferredDomains || '').split(/[\n;]+/).map(function(s){ return s.trim(); }).filter(Boolean).forEach(function(s){ lines.push(s); });  // URL 感知：含查询串逗号的 URL 整行保留，不按逗号切碎
  (CFG.preferredIPs || []).forEach(function(x){
    lines.push((String(x.ip).indexOf(':') >= 0 ? '[' + x.ip + ']' : x.ip) + ':' + (x.port || 443) + (x.name ? ('#' + x.name) : ''));
  });
  $('f-preferred').value = lines.join('\n');
}
function fillPort(pv){
  pv = String(pv == null ? 443 : pv);
  var sel = $('o-port');
  var found = false;
  for (var i = 0; i < sel.options.length; i++){ if (sel.options[i].value === pv){ found = true; break; } }
  if (found){ sel.value = pv; $('o-portC').style.display = 'none'; }
  else { sel.value = 'custom'; $('o-portC').value = pv; $('o-portC').style.display = ''; }
}
function fillForm(){
  if (!CFG) return;
  $('en-${a("dmxlc3M=")}').checked = CFG.enable${a("Vmxlc3M=")} !== false;
  $('en-${a("dHJvamFu")}').checked = !!CFG.enable${a("VHJvamFu")};
  $('tp-pass').value = CFG.${a("dHJvamFu")}Password || '';
  $('en-${a("eGh0dHA=")}').checked = !!CFG.enable${a("WGh0dHA=")};
  $('tls-only').checked = !!CFG.tlsOnly;
  $('${a("YWxwbg==")}').value = CFG.${a("YWxwbg==")} || '';
  $('ech-on').checked = !!CFG.ech;
  $('ech-host').value = CFG.echHost || '';
  $('ech-dns').value = CFG.echDns || '';
  var fl = CFG.filter || {};
  var region = fl.region || 'all';
  var regionArr = Array.isArray(region) ? region : (region === 'all' ? ['all'] : [region]);
  $('fl-region-all').checked = regionArr.indexOf('all') >= 0;
  ['HK', 'TW', 'US', 'SG', 'JP', 'KR', 'DE'].forEach(function(r){ $('fl-region-' + r).checked = regionArr.indexOf(r) >= 0; });
  var ipType = fl.ipType || ['IPv4'];
  $('fl-ip4').checked = ipType.indexOf('IPv4') >= 0;
  $('fl-ip6').checked = ipType.indexOf('IPv6') >= 0;
  var ip6 = CFG.ipv6Mode || 'off';
  $('ip6-off').checked = ip6 !== 'tail' && ip6 !== 'full';
  $('ip6-tail').checked = ip6 === 'tail';
  $('ip6-full').checked = ip6 === 'full';
  var isp = fl.isp || ['移动', '联通', '电信'];
  $('fl-isp-m').checked = isp.indexOf('移动') >= 0;
  $('fl-isp-c').checked = isp.indexOf('联通') >= 0;
  $('fl-isp-t').checked = isp.indexOf('电信') >= 0;
  var src = CFG.src || {};
  $('fl-native').checked = src.native === true;
  $('fl-pref-domain').checked = src.prefDomain !== false;
  $('fl-pref-ip').checked = src.prefIp !== false;
  $('fl-custom-pref').checked = src.customPref === true;
  var o = CFG.optimizer || {};
  $('o-source').value = o.source || 'wetest_v4';
  $('o-sourceURL').value = o.sourceURL || '';
  $('o-fbpool').value = o.${a("ZmFsbGJhY2s=")}Pool || '';
  fillPort(o.port);
  $('o-threads').value = o.threads || 5;
  $('o-count').value = o.count || 20;
  $('o-fill').value = (o.fillCount == null ? 0 : o.fillCount);
  $('o-useCidr').checked = o.useCidr !== false;
  $('o-submode').value = o.subMode || '';
  $('o-subinc').value = (o.subIncludeDefault ? '1' : '0');
  $('o-rand').value = o.subRandomCount == null ? 16 : o.subRandomCount;
  $('q-nl-on').checked = !!CFG.nodeLimit;
  $('q-nl-count').value = CFG.nodeLimitCount || 300;
  $('q-cpu-on').checked = !!CFG.cpuLimit;
  $('q-clabel').value = CFG.countryLabel || '';
  $('q-lb-on').checked = CFG.loadBalance !== false;  $('q-auto-on').checked = !!CFG.quotaAuto;
  $('q-strict-on').checked = !!CFG.quotaStrict;
  $('a-uuid').value = CFG.uuid || '';
  $('a-suburl').value = CFG.subUrl || '';
  $('a-admin').value = CFG.admin || '';
  $('a-cfid').value = CFG.cfAccountId || '';
  $('q-tgtoken').value = CFG.tgBotToken || '';
  $('q-tgchat').value = CFG.tgChatID || '';
  $('a-cftoken').value = CFG.cfApiToken || '';
  $('hw-on').checked = !!CFG.homeWan;
  $('hw-cfg').value = CFG.hwCfg || '';
  $('s-${a("cHJveHlJUA==")}').value = CFG.${a("cHJveHlJUA==")} || '';
  $('s-${a("b3V0Ym91bmQ=")}').value = CFG.${a("b3V0Ym91bmQ=")}Proxy || '';
  $('s-outmode').value = CFG.${a("b3V0Ym91bmQ=")}Mode || '';
  $('a-mode').value = curMode();
  $('w-on').checked = !!CFG.warpEnable;
  setWStat();
  $('w-eps').value = CFG.warpEps || '';
  $('w-front').value = CFG.warpFront || '';
  $('w-name').value = CFG.warpName || 'WARP';
  $('x-on').checked = !!CFG.${a("bWFzcXVl")}Enable;
  $('x-conf').value = CFG.${a("bWFzcXVl")}Conf || '';
  $('x-name').value = CFG.${a("bWFzcXVl")}Name || '${a("TUFTUVVF")}';
  $('x-eps').value = CFG.${a("bWFzcXVl")}Eps || '';
  renderPreferred();
  bindRegionPills();
  onSubMode();
  $('o-customWrap').style.display = ($('o-source').value === 'custom') ? '' : 'none';
}
// 节点地区多选互斥：勾选具体地区时取消「全部地区」；全部取消时自动恢复「全部地区」（保证筛选非空）
function bindRegionPills(){
  if (window.__regionPillsBound) return;
  window.__regionPillsBound = true;
  var codes = ['HK', 'TW', 'US', 'SG', 'JP', 'KR', 'DE'];
  var all = $('fl-region-all');
  all.addEventListener('change', function(){
    if (all.checked) codes.forEach(function(r){ $('fl-region-' + r).checked = false; });
  });
  codes.forEach(function(c){
    $('fl-region-' + c).addEventListener('change', function(){
      if ($('fl-region-' + c).checked) all.checked = false;
      var any = codes.some(function(r){ return $('fl-region-' + r).checked; });
      if (!any) all.checked = true;
    });
  });
}
function collectForm(){
  if (!CFG) return null;
  var ipLines = [], domLines = [];
  // URL 感知收集：URL（含 ://）整行原样保留（查询串自带逗号不打碎，如 ?region=NL,GB,FI）；
  // 非 URL 行仍支持逗号/分号分隔多条 IP（兼容 "1.2.3.4:443#名, 5.6.7.8" 旧用法）
  String($('f-preferred').value).split(/\n+/).map(function(s){ return s.trim(); }).filter(Boolean).forEach(function(s){
    if (s.indexOf('://') >= 0){ domLines.push(s); return; }
    s.split(/[;,]+/).map(function(x){ return x.trim(); }).filter(Boolean).forEach(function(x){
      if (parseIps(x).length) ipLines.push(x); else domLines.push(x);
    });
  });
  var ips = [], seen = {};
  ipLines.forEach(function(s){
    var p = parseIps(s);
    if (!p.length) return;
    var k = p[0].ip + ':' + (p[0].port || 443);
    if (seen[k]) return;
    seen[k] = 1;
    ips.push(p[0]);
  });
  return {
    mode: $('a-mode').value || '',
    warpEnable: $('w-on').checked,
    warpConf: CFG.warpConf || '',
    warpEps: $('w-eps').value,
    warpFront: $('w-front').value,
    warpName: $('w-name').value.trim() || 'WARP',
    ${a("bWFzcXVl")}Enable: $('x-on').checked,
    ${a("bWFzcXVl")}Conf: $('x-conf').value,
    ${a("bWFzcXVl")}Name: $('x-name').value.trim() || '${a("TUFTUVVF")}',
    ${a("bWFzcXVl")}Eps: $('x-eps').value,
    uuid: $('a-uuid').value.trim(),
    subUrl: $('a-suburl').value.trim(),
    admin: $('a-admin').value,
    ${a("YWxwbg==")}: $('${a("YWxwbg==")}').value,
    ech: $('ech-on').checked,
    echHost: $('ech-host').value.trim() || 'cloudflare-ech.com',
    echDns: $('ech-dns').value.trim(),
    tlsOnly: $('tls-only').checked,
    nodeLimit: $('q-nl-on').checked,
    nodeLimitCount: parseInt($('q-nl-count').value) || 300,
    cpuLimit: $('q-cpu-on').checked,
    countryLabel: $('q-clabel').value,
    loadBalance: $('q-lb-on').checked,
    ipv6Mode: $('ip6-tail').checked ? 'tail' : ($('ip6-full').checked ? 'full' : 'off'),    cfAccountId: $('a-cfid').value.trim(),
    tgBotToken: $('q-tgtoken').value.trim(),
    tgChatID: $('q-tgchat').value.trim(),
    cfApiToken: $('a-cftoken').value.trim(),
    quotaAuto: $('q-auto-on').checked,
    quotaStrict: $('q-strict-on').checked,
    enable${a("Vmxlc3M=")}: $('en-${a("dmxlc3M=")}').checked,
    enable${a("VHJvamFu")}: $('en-${a("dHJvamFu")}').checked,
    ${a("dHJvamFu")}Password: $('tp-pass').value,
    enable${a("WGh0dHA=")}: $('en-${a("eGh0dHA=")}').checked,
    homeWan: $('hw-on').checked,
    hwCfg: $('hw-cfg').value,
    ${a("cHJveHlJUA==")}: $('s-${a("cHJveHlJUA==")}').value.trim(),
    ${a("b3V0Ym91bmQ=")}Proxy: $('s-${a("b3V0Ym91bmQ=")}').value.trim(),
    ${a("b3V0Ym91bmQ=")}Mode: $('s-outmode').value,
    preferredDomains: domLines.join('\n'),
    preferredIPs: ips,
    optimizer: {
      source: $('o-source').value,
      sourceURL: $('o-sourceURL').value.trim(),
      ${a("ZmFsbGJhY2s=")}Pool: $('o-fbpool').value.trim(),
      port: parseInt($('o-port').value === 'custom' ? $('o-portC').value : $('o-port').value) || 443,
      threads: parseInt($('o-threads').value) || 5,
      count: parseInt($('o-count').value) || 20,
      fillCount: parseInt($('o-fill').value) || 0,
      useCidr: $('o-useCidr').checked,
      subMode: $('o-submode').value,
      subRandomCount: parseInt($('o-rand').value) || 16,
      subIncludeDefault: $('o-subinc').value === '1'
    },
    filter: {
      region: (function(){
        if ($('fl-region-all').checked) return ['all'];
        var a = [];
        ['HK', 'TW', 'US', 'SG', 'JP', 'KR', 'DE'].forEach(function(r){ if ($('fl-region-' + r).checked) a.push(r); });
        return a.length ? a : ['all'];
      })(),
      ipType: (function(){ var a = []; if ($('fl-ip4').checked) a.push('IPv4'); if ($('fl-ip6').checked) a.push('IPv6'); return a; })(),
      isp: (function(){ var a = []; if ($('fl-isp-m').checked) a.push('移动'); if ($('fl-isp-c').checked) a.push('联通'); if ($('fl-isp-t').checked) a.push('电信'); return a; })()
    },
    src: {
      native: $('fl-native').checked,
      prefDomain: $('fl-pref-domain').checked,
      prefIp: $('fl-pref-ip').checked,
      customPref: $('fl-custom-pref').checked
    }
  };
}
function saveAll(){
  if (!CFG){ toast('配置尚未加载', 'err'); return; }
  var body = collectForm();
  var btn = $('saveBtn');
  btn.disabled = true;
  api('config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(function(r){
      if (r && r.ok){
        CFG = r.data;
        // UUID 即入口路径：改 UUID 会改变入口与订阅地址，需跳转到新入口，否则停留在旧路径会落到欢迎页
        var nEntry = '/' + String((r.data && r.data.path) || '').replace(/^\/+/, '');
        if (nEntry !== '/' && nEntry !== APIPATH){
          toast('入口地址已随 UUID 变更，正在跳转…', 'ok');
          setTimeout(function(){ location.href = nEntry; }, 1200);
          return;
        }
        fillForm();
        renderAll();
        makeSub(false);
        refreshQuota();
        btn.classList.remove('dirty');
        $('savedAt').textContent = '已保存：' + new Date().toLocaleTimeString();
        toast('已保存并生效，正在刷新…', 'ok');
        setTimeout(function(){ location.reload(); }, 800);
      } else toast((r && r.msg) || '保存失败', 'err');
    })
    .catch(function(){ toast('保存失败：无法连接服务器', 'err'); })
    .then(function(){ btn.disabled = false; });
}
function hwCustomApply(){
  var el = $('hw-cfg'), st = $('hw-cfg-stat');
  if (!el || !st) return;
  var hosts = [], hasCrypto = false;
  String(el.value || '').split(/\n+/).forEach(function(line){
    var s = String(line || '').trim();
    if (!s || s.charAt(0) === '#') return;
    if (/^(ca|cert|key|tls-auth|tls-crypt)\s*[:=]/i.test(s)) { hasCrypto = true; return; }
    if (/^-{3,}/.test(s) || /^[A-Za-z0-9+/=\s]{16,}$/.test(s)) return;
    var m = /^([A-Za-z]{2})\s*[:|]\s*([\s\S]+)$/.exec(s);
    var body = s, code = '';
    if (m) { code = m[1].toUpperCase(); body = m[2].trim(); }
    var b64 = body.replace(/\s+/g, '');
    if (b64.length >= 200 && /^[A-Za-z0-9+/=]+$/.test(b64)) { hosts.push('配置(' + (code || 'XX') + ')'); return; }
    var p = body.split(/[\s:]+/).filter(Boolean);
    if (p.length) hosts.push(p[0] + ':' + (parseInt(p[1], 10) || 1194) + '/' + (/udp/i.test(p[2] || '') ? 'udp' : 'tcp'));
  });
  st.textContent = hosts.length
    ? ('解析到 ' + hosts.length + ' 条：' + hosts.slice(0, 4).join('、') + (hosts.length > 4 ? ' …' : '') + (hasCrypto ? '（含证书块）' : '（无证书块的行会被忽略）'))
    : '未解析到有效条目';
  toast(hosts.length ? ('解析到 ' + hosts.length + ' 条') : '没有解析到条目', hosts.length ? 'ok' : 'err');
}
function resetAll(){
  if (!confirm('确定重置？将清空 KV 中全部面板配置与节点记录，面板还原为初始部署状态。此操作不可恢复！')) return;
  var btn = $('resetBtn');
  btn.disabled = true;
  api('reset', { method: 'POST' })
    .then(function(r){
      if (r && r.ok){ toast(r.msg || '已重置', 'ok'); setTimeout(function(){ location.href = APIPATH; }, 900); }
      else toast((r && r.msg) || '重置失败', 'err');
    })
    .catch(function(){ toast('重置失败：无法连接服务器', 'err'); })
    .then(function(){ btn.disabled = false; });
}
function genUuid(){
  var u = '';
  if (window.crypto && crypto.randomUUID){ u = crypto.randomUUID(); }
  else {
    var tpl = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx';
    u = tpl.replace(/[xy]/g, function(c){
      var r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 3 | 8);
      return v.toString(16);
    });
  }
  $('a-uuid').value = u;
  markDirty();
  toast('已生成新 UUID', 'ok');
}
// 备份：把当前面板表单值收集成 JSON 下载（与保存配置同一套字段，恢复后可直接保存）
function exportConfig(){
  try {
    var data = collectForm();
    var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    var ts = new Date();
    var pad = function(n){ return String(n).padStart(2, '0'); };
    a.download = '${a("Y2ZuZXh0")}-backup-' + ts.getFullYear() + pad(ts.getMonth()+1) + pad(ts.getDate()) + '-' + pad(ts.getHours()) + pad(ts.getMinutes()) + '.json';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function(){ URL.revokeObjectURL(a.href); }, 1000);
    toast('配置已导出为 JSON', 'ok');
  } catch (e) { toast('导出失败：' + e.message, 'err'); }
}
// 恢复：读取 JSON 填充表单，标记未保存，由用户点「保存全部」写盘
function importConfig(input){
  var file = input.files && input.files[0];
  if (!file) return;
  var reader = new FileReader();
  reader.onload = function(){
    try {
      var data = JSON.parse(reader.result);
      CFG = Object.assign({}, CFG, data);
      fillForm();
      renderAll();
      markDirty();
      toast('配置已导入，请点「保存全部」生效', 'ok');
    } catch (e) { toast('导入失败：JSON 格式不正确', 'err'); }
    input.value = '';
  };
  reader.readAsText(file, 'utf-8');
}
document.querySelectorAll('input,select,textarea').forEach(function(el){
  var id = el.id || '';
  var prefixes = ['f-', 'o-', 'a-', 's-', 'q-', 'e-', 't-', 'fl-', 'en-'];
  for (var i = 0; i < prefixes.length; i++){ if (id.indexOf(prefixes[i]) === 0){ el.addEventListener('change', markDirty); break; } }
});

/* ===== 订阅 ===== */
function subUrlOf(fmt){
  // 自定义订阅路径优先：自动保留当前域名（location.origin），只替换路径段；
  // 用户只填 UUID/别名段（如 AAZ），拼成 https://当前域名/AAZ/sub；留空用 UUID。
  // 填了 /sub 结尾或带前后斜杠时自动归一，格式后缀（${a("Y2xhc2g=")}/${a("c2luZ2JveA==")} 等）拼为 /sub/<格式>
  var custom = (window.CFG && CFG.subUrl) ? String(CFG.subUrl).trim().replace(/^\/+/, '').replace(/\/sub$/, '').replace(/\/+$/, '') : '';
  var base = custom ? (location.origin + '/' + custom) : (location.origin + APIPATH);
  var u = base + '/sub';
  return fmt ? (u + '/' + fmt) : u;
}
function makeSub(showQR){
  var fmt = $('subFmt').value;
  var url = subUrlOf(fmt === 'auto' ? '' : fmt);
  $('subUrl').value = url;
  if (showQR) showQRCode(url);
}
$('subFmt').addEventListener('change', function(){ makeSub(false); });
function toggleQR(){
  var w = $('qrWrap');
  if (w.style.display === 'block'){ w.style.display = 'none'; return; }
  showQRCode($('subUrl').value || subUrlOf(''));
}
function showQRCode(url){
  var w = $('qrWrap');
  w.style.display = 'block';
  if (typeof qrcode === 'undefined'){ w.innerHTML = '<div class="hint">二维码库加载失败，请直接复制链接</div>'; return; }
  try {
    var fmt = ($('subFmt') && $('subFmt').value) || 'auto';
    var q = qrcode(0, 'M');
    q.addData(qrPayloadOf(fmt, url));
    q.make();
    w.innerHTML = '<div class="qrbox">' + q.createImgTag(4, 10) + '</div>';
  } catch(e) { w.innerHTML = '<div class="hint">二维码生成失败：' + e.message + '</div>'; }
}
// 二维码内容随订阅格式（客户端）联动：
// ${a("Q2xhc2g=")}/${a("TWlob21v")}、${a("U3Rhc2g=")} → ${a("Y2xhc2g=")}://install-config（Fly${a("Q2xhc2g=")} / ${a("Q2xhc2g=")} Verge / ${a("U3Rhc2g=")} 扫码装订阅，配置名取订阅响应头 filename=${a("Q0ZOZXh0")}）
// ${a("U2luZy1ib3g=")} → ${a("c2luZy1ib3g=")}://import-remote-profile?url=...#${a("Q0ZOZXh0")}（官方 scheme，# 后为配置文件名称）
// ${a("U3VyZ2U=")} → ${a("c3VyZ2U=")}:///install-config（${a("U3VyZ2U=")} 官方 scheme）
// auto / ${a("djJyYXlO")}+${a("U2hhZG93cm9ja2V0")} / ${a("TG9vbg==")} / ${a("UXVhbnR1bXVsdA==")} X / 明文 → 直接使用订阅链接（${a("U2hhZG93cm9ja2V0")} / ${a("TG9vbg==")} / ${a("UXVhblg=")} 扫码识别）
function qrPayloadOf(fmt, url){
  var enc = encodeURIComponent(url);
  if (fmt === '${a("Y2xhc2g=")}' || fmt === '${a("c3Rhc2g=")}') return '${a("Y2xhc2g=")}://install-config?url=' + enc;
  if (fmt === '${a("c2luZ2JveA==")}') return '${a("c2luZy1ib3g=")}://import-remote-profile?url=' + enc + '#' + __B;
  if (fmt === '${a("c3VyZ2U=")}') return '${a("c3VyZ2U=")}:///install-config?url=' + enc;
  return url;
}
function downloadSub(){
  var fmt = $('subFmt').value;
  var url = subUrlOf(fmt === 'auto' ? '' : fmt);
  // 保存名按所选格式给出（内容随管理接口返回，不再依赖响应头里的文件名）
  var names = { ${a("Y2xhc2g=")}:__B+'.yaml', ${a("c3Rhc2g=")}:__B+'.yaml', ${a("c2luZ2JveA==")}:__B+'.json', ${a("c3VyZ2U=")}:__B+'.conf', ${a("c3VyZmJvYXJk")}:__B+'.conf', ${a("bG9vbg==")}:__B+'.conf', ${a("cXVhbng=")}:__B+'.conf' };
  var name = names[fmt] || __B + '.txt';
  var w = $('qrWrap');
  // 兜底出口：脚本触发的保存若被浏览器或内置 WebView 拦下，就给出一个真实链接
  // （用户手势点它一定会走浏览器原生下载，不经过脚本）
  function alt(msg){
    toast(msg, 'err');
    if (!w) return;
    w.style.display = 'block';
    w.innerHTML = '<div class="hint" style="margin-top:0">' + msg + ' 可<a href="' + url + '" download="' + name + '" style="text-decoration:underline">点此直接下载</a>，也可复制订阅链接导入客户端。</div>';
  }
  toast('正在生成 ' + name + ' …', '');
  // 与「预览」共用管理通道：订阅正文随 JSON 一并返回，
  // 不再依赖 /sub 的 Content-Disposition —— 那条响应头在部分托管环境会被改写
  api('sub?fmt=' + encodeURIComponent(fmt === 'auto' ? '' : fmt))
    .then(function(r){
      if (!r || !r.ok) throw new Error((r && r.msg) || '服务端未返回内容');
      var body = r.body || '';
      if (!body) throw new Error('订阅内容为空');
      var bu = URL.createObjectURL(new Blob([body], { type: 'application/octet-stream' }));
      var a = document.createElement('a');
      a.href = bu;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function(){ URL.revokeObjectURL(bu); }, 6e4);
      toast('已保存 ' + name + '（' + Math.max(1, Math.round(body.length / 1024)) + ' KB）', 'ok');
    })
    .catch(function(e){ alt('下载失败：' + ((e && e.message) || e)); });
}
function previewSub(){
  var fmt = $('subFmt').value;
  var box = $('subPrev');
  box.style.display = 'block';
  $('prevType').textContent = '请求中…';
  $('prevCount').textContent = '—';
  $('prevBody').textContent = '';
  api('sub?fmt=' + encodeURIComponent(fmt === 'auto' ? '' : fmt))
    .then(function(r){
      if (!r || !r.ok){ $('prevType').textContent = '预览失败'; $('prevBody').textContent = (r && r.msg) || '未知错误'; return; }
      var body = r.body || '';
      var type = r.type || '';
      $('prevType').textContent = type || '—';
      var n = 0;
      if (/${a("Y2xhc2g=")}|yaml/i.test(type)) n = (body.match(/- name:/g) || []).length;
      else if (/json/i.test(type)) n = (body.match(/"tag"/g) || []).length;
      else {
        var t = body;
        if (!/^(${a("dmxlc3M=")}|${a("dHJvamFu")}|ss|${a("eGh0dHA=")}):\/\//m.test(t)) {
          try { t = atob(t); } catch (e) { /* 保持原样 */ }
        }
        n = t.split('\n').filter(function(l){ return /^(${a("dmxlc3M=")}|${a("dHJvamFu")}|ss|${a("eGh0dHA=")}):\/\//.test(l.trim()); }).length;
      }
      $('prevCount').textContent = n + ' 个节点';
      $('prevBody').textContent = body.length > 2600 ? body.slice(0, 2600) + '\n…（已截断，完整内容请下载）' : body;
    })
    .catch(function(){ $('prevType').textContent = '预览失败：无法连接服务器'; $('prevBody').textContent = ''; });
}

/* ===== 优选配置 ===== */
function onPortSel(){
  var sel = $('o-port');
  var c = $('o-portC');
  c.style.display = sel.value === 'custom' ? '' : 'none';
}
function onSubMode(){
  var m = $('o-submode').value;
  $('sm-custom').style.display = (m === 'custom') ? '' : 'none';
  $('sm-random').style.display = (m === 'random') ? '' : 'none';
  // 「追加内置优选池与默认地区源」仅在自定义订阅 / 随机优选模式下可选；
  // 订阅模式关闭（使用面板默认节点池）时强制为关闭并禁用，避免默认模式下误开追加导致行为不符
  if (m === '') {
    $('o-subinc').value = '0';
    $('o-subinc').disabled = true;
  } else {
    $('o-subinc').disabled = false;
  }
  // 订阅模式与仪表盘「地址来源」胶囊互斥同步（三态全部明确跟随）：
  // custom → 自定义优选开、随机优选关；random → 随机优选开、自定义优选关；关闭 → 两个胶囊都关
  if (m === 'custom') {
    $('fl-custom-pref').checked = true;
    $('fl-random-pref').checked = false;
  } else if (m === 'random') {
    $('fl-custom-pref').checked = false;
    $('fl-random-pref').checked = true;
  } else {
    $('fl-custom-pref').checked = false;
    $('fl-random-pref').checked = false;
  }
}
// 仪表盘「地址来源 → 自定义优选」与优选配置「订阅模式」联动：
// 勾选 → 订阅模式切为「自定义订阅（支持汇聚）」并关闭随机优选；取消 → 订阅模式关闭（使用面板默认节点池）
$('fl-custom-pref').addEventListener('change', function(){
  if (this.checked) {
    $('fl-random-pref').checked = false;   // 与随机优选互斥
    $('o-submode').value = 'custom';
  } else {
    if ($('o-submode').value === 'custom') $('o-submode').value = '';
  }
  onSubMode();
});
// 仪表盘「地址来源 → 随机优选」与优选配置「订阅模式 → 随机优选模式（官方接口）」联动：
// 勾选 → 订阅模式切为 random 并关闭自定义优选；取消 → 订阅模式关闭（若当前为 random）
$('fl-random-pref').addEventListener('change', function(){
  if (this.checked) {
    $('fl-custom-pref').checked = false;   // 与自定义优选互斥
    $('o-submode').value = 'random';
  } else {
    if ($('o-submode').value === 'random') $('o-submode').value = '';
  }
  onSubMode();
});
$('o-source').addEventListener('change', function(){
  $('o-customWrap').style.display = ($('o-source').value === 'custom') ? '' : 'none';
});
function pingIp(ip, port, timeout){
  var t0 = Date.now();
  var addr = ip.indexOf(':') >= 0 ? '[' + ip + ']' : ip;
  var proto = (port === 80 || port === 8080 || port === 8880 || port === 2052 || port === 2082 || port === 2086 || port === 2095) ? 'http' : 'https';
  var ctrl = new AbortController();
  var timer = setTimeout(function(){ ctrl.abort(); }, timeout);
  return fetch(proto + '://' + addr + ':' + port + '/', { mode: 'no-cors', cache: 'no-store', redirect: 'manual', signal: ctrl.signal })
    .then(function(){ clearTimeout(timer); return { ok: true, latency: Date.now() - t0 }; })
    .catch(function(){
      clearTimeout(timer);
      var ms = Date.now() - t0;
      if (proto === 'http' && ms < 100) return pingHttps(ip, port, timeout);
      return { ok: ms < timeout, latency: ms };
    });
}
function pingHttps(ip, port, timeout){
  var t0 = Date.now();
  var addr = ip.indexOf(':') >= 0 ? '[' + ip + ']' : ip;
  var ctrl = new AbortController();
  var timer = setTimeout(function(){ ctrl.abort(); }, timeout);
  return fetch('https://' + addr + ':' + port + '/', { mode: 'no-cors', cache: 'no-store', redirect: 'manual', signal: ctrl.signal })
    .then(function(){ clearTimeout(timer); return { ok: true, latency: Date.now() - t0 }; })
    .catch(function(){ clearTimeout(timer); var ms = Date.now() - t0; return { ok: ms < timeout, latency: ms }; });
}
function localTest(cands, threads, timeout){
  var results = [], idx = 0, pending = 0;
  return new Promise(function(resolve){
    function next(){
      while (pending < threads && idx < cands.length) {
        (function(c){
          pending++;
          pingIp(c.ip, c.port, timeout).then(function(r){
            pending--;
            results.push({ ip: c.ip, port: c.port, name: c.name || '', ok: r.ok, latency: r.latency });
            if (results.length === cands.length) resolve(results);
            else next();
          });
        })(cands[idx++]);
      }
    }
    next();
  });
}
function runPick(){
  if (!CFG){ toast('配置尚未加载', 'err'); return; }
  var o = collectForm().optimizer;
  showMsg('oMsg', '正在拉取候选 IP…', 'info');
  api('candidates', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o) })
    .then(function(r){
      if (!r || !r.ok){ showMsg('oMsg', (r && r.msg) || '拉取失败', 'err'); return; }
      var cands = r.data || [];
      if (!cands.length){ showMsg('oMsg', (r && r.msg) || '没有可测的 IP，请换一个数据源', 'err'); return; }
      var st = r.stats || {};
      var parts = [];
      if (st.preset) parts.push('预设源 ' + st.preset + ' 条');
      if (st.presetErr) parts.push('预设源失败(' + st.presetErr + ')');
      if (st.custom) parts.push('自定义源 ' + st.custom + ' 条');
      if (st.customErr) parts.push('自定义源失败(' + st.customErr + ')');
      if (st.cidr) parts.push('CF 补足 ' + st.cidr + ' 条');
      // 候选数量截断：自定义 URL 源可能拉取上千条候选（第三方优选 IP 文档动辄上千条），全量测速耗时过长；
      // 按「候选数量」只测前 N 条（可调高数值测更多），测速列表与「全部加入最优」均基于该子集
      var candSub = (o.count > 0 && cands.length > o.count) ? cands.slice(0, o.count) : cands;
      showMsg('oMsg', '拉取 ' + cands.length + ' 条（' + (parts.join('，') || '无') + '），本地测速前 ' + candSub.length + ' 条…', 'info');
      localTest(candSub, o.threads || 5, 3000).then(function(results){
        results.sort(function(a, b){ return (a.latency < 0 ? 1e9 : a.latency) - (b.latency < 0 ? 1e9 : b.latency); });
        renderResults(results);
        var okc = results.filter(function(x){ return x.ok; }).length;
        showMsg('oMsg', '测速完成：' + okc + '/' + results.length + ' 可用（本地 → 目标）', okc ? 'ok' : 'err');
      });
    })
    .catch(function(){ showMsg('oMsg', '拉取失败：无法连接服务器', 'err'); });
}
function renderResults(list){
  var seen = {};
  var dedup = [];
  (list || []).forEach(function(r){
    if (seen[r.ip]) return;
    seen[r.ip] = 1;
    dedup.push(r);
  });
  LAST = dedup;
  var tb = $('oTableBody');
  tb.innerHTML = '';
  if (!LAST.length){ tb.innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--faint)">没有可用结果</td></tr>'; return; }
  LAST.forEach(function(r, i){
    var tr = document.createElement('tr');
    var ok = r.ok;
    var lag = ok ? (r.latency + 'ms') : '超时';
    var badge = '<span class="badge ' + (ok ? 'g' : 'r') + '">' + (ok ? '可用' : '超时') + '</span>';
    var btn = ok ? '<button class="btn sm primary" onclick="useIp(' + i + ')">加入优选</button>' : '<span style="color:var(--faint)">—</span>';
    tr.innerHTML = '<td class="ip">' + r.ip + ':' + r.port + '</td><td>' + lag + '</td><td>' + badge + '</td><td>' + btn + '</td>';
    tb.appendChild(tr);
  });
}
function useIp(i){
  var r = LAST[i];
  if (!r) return;
  var ta = $('f-preferred');
  var line = r.ip + ':' + r.port + (r.name ? ('#' + r.name) : '');
  var exists = false;
  String(ta.value || '').split(/[\n,;]+/).forEach(function(s){
    var p = parseIps(s);
    if (p.length && p[0].ip === r.ip) exists = true;
  });
  if (exists){ toast('该 IP 已在优选列表中', 'warn'); return; }
  var s = ta.value.trim();
  ta.value = s ? (s + '\n' + line) : line;
  markDirty();
  toast('已加入优选列表，点击「保存全部」下发', 'ok');
}
function addAllBest(){
  var n = parseInt($('o-count').value) || 20;
  var seen = {};
  var list = [];
  LAST.filter(function(r){ return r.ok; }).forEach(function(r){
    if (seen[r.ip] || list.length >= n) return;
    seen[r.ip] = 1;
    list.push(r);
  });
  if (!list.length){ toast('没有可用结果', 'err'); return; }
  var arr = [];
  // 保留原节点名：防地区信息丢失导致订阅无国家显示；无名条目才编「优选N」
  list.forEach(function(r, i){ arr.push(r.ip + ':' + r.port + (r.name ? ('#' + r.name) : ('#优选' + (i + 1)))); });
  $('f-preferred').value = arr.join('\n');
  markDirty();
  toast('已加入最快的 ' + list.length + ' 个优选 IP，点击「保存全部」下发', 'ok');
}
function fetchDomains(){
  api('domains').then(function(r){
    if (r && r.ok && r.data && r.data.length){ $('f-preferred').value = r.data.join('\n'); markDirty(); toast('已拉取优选域名', 'ok'); }
    else toast((r && r.msg) || '拉取失败', 'err');
  }).catch(function(){ toast('拉取失败：无法连接服务器', 'err'); });
}

/* ===== 启动 ===== */
buildNav();
var initView = 'dashboard';
try {
  var qv = new URLSearchParams(location.search).get('v');
  if (qv && TITLES[qv]) initView = qv;
} catch(e) {}
switchView(initView);
loadAll();

/* 液态玻璃：高光跟随指针 */
var GLASS_EL=null,GLASS_EV=null,GLASS_RAF=0;
function glassTick(){GLASS_RAF=0;if(!GLASS_EL||!GLASS_EV)return;var r=GLASS_EL.getBoundingClientRect();if(!r.width||!r.height)return;GLASS_EL.style.setProperty('--mx',((GLASS_EV.clientX-r.left)/r.width*100).toFixed(1)+'%');GLASS_EL.style.setProperty('--my',((GLASS_EV.clientY-r.top)/r.height*100).toFixed(1)+'%');}
function bindGlass(){if(window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches)return;if (typeof mdPaint === 'function') mdPaint();
document.addEventListener('pointerdown', function(e){ if (typeof mdRipple === 'function') mdRipple(e); }, true);
/* 鼠标跟随高光已按用户要求移除（原 pointermove → glassTick 沿光标刷新卡片高光） */
document.addEventListener('pointerleave',function(){GLASS_EL=null;});}
bindGlass();
</script>
</body>
</html>

`;function St(t,e,r,n,o){try{return Dr(t,{uuid:r.uuid,enableTrojan:r.enableTrojan,trojanPassword:r.trojanPassword,proxyIP:r.proxyIp,outboundProxy:"",outboundMode:"",path:r.wsPath.replace(/^\//,"")})}catch{return new Response("\u670D\u52A1\u6682\u4E0D\u53EF\u7528",{status:503,headers:{"Content-Type":"text/plain; charset=utf-8"}})}}var ie=class{reader;chunks=[];size=0;done=!1;constructor(e){this.reader=e.getReader()}async readExactly(e){if(e===0)return new Uint8Array(0);for(;this.size<e;){if(this.done)return null;let{done:r,value:n}=await this.reader.read();if(r)return this.done=!0,this.size>=e?this.take(e):null;n&&n.byteLength>0&&(this.chunks.push(n),this.size+=n.byteLength)}return this.take(e)}take(e){let r=new Uint8Array(e),n=0;for(;n<e;){let o=this.chunks[0],i=e-n;o.byteLength<=i?(r.set(o,n),n+=o.byteLength,this.chunks.shift()):(r.set(o.subarray(0,i),n),this.chunks[0]=o.subarray(i),n+=i)}return this.size-=e,r}async peekExactly(e){if(e===0)return new Uint8Array(0);for(;this.size<e;){if(this.done)return null;let{done:r,value:n}=await this.reader.read();if(r)return this.done=!0,this.size>=e?this.slice(e):null;n&&n.byteLength>0&&(this.chunks.push(n),this.size+=n.byteLength)}return this.slice(e)}skip(e){return this.size<e?null:this.take(e)}slice(e){let r=new Uint8Array(e),n=0;for(let o of this.chunks){if(n>=e)break;let i=Math.min(o.byteLength,e-n);r.set(o.subarray(0,i),n),n+=i}return r}peek(){if(this.chunks.length===0)return new Uint8Array(0);let e=this.chunks.reduce((o,i)=>o+i.byteLength,0),r=new Uint8Array(e),n=0;for(let o of this.chunks)r.set(o,n),n+=o.byteLength;return r}release(){let e=this.peek();this.chunks=[],this.size=0;let r=this.reader,n=this,o=!1;return new ReadableStream({async pull(i){if(!o&&(o=!0,e.byteLength>0)){i.enqueue(e);return}if(n.done){i.close();return}try{let{done:s,value:c}=await r.read();s?(n.done=!0,i.close()):c&&c.byteLength>0&&i.enqueue(c)}catch(s){i.error(s)}},cancel(i){r.cancel(i)}})}};ve();var Fr=1;var $r="0123456789abcdef";function Qn(t){let e=t.replace(/-/g,"").trim().toLowerCase();if(!/^[0-9a-f]{32}$/.test(e))return null;let r=new Uint8Array(16);for(let n=0;n<16;n++)r[n]=parseInt(e.slice(n*2,n*2+2),16);return r}function Or(t){let e="";for(let r of t)e+=$r[r>>4]+$r[r&15];return e}async function Hr(t,e){let r=await t.readExactly(1);if(!r)return null;let n=await t.readExactly(16);if(!n)return null;let o=Qn(e);if(!o||Or(n)!==Or(o))return null;let i=await t.readExactly(1);if(!i)return null;let s=i[0],c=s>0?await t.readExactly(s):new Uint8Array(0);if(!c)return null;let l=await t.readExactly(1);if(!l)return null;let u=await t.readExactly(2);if(!u)return null;let p=await Nt(t,!0);if(!p)return null;let d=u[0]<<8|u[1];return{header:{version:r[0],command:l[0],port:d,hostname:p.hostname,addressType:p.addressType,addons:c},payload:t.release()}}bt();ve();async function Wr(t,e,r,n,o={}){let i=new ie(t),s=e.getWriter(),c=async l=>{await s.write(l)};try{let l=[0];o.username&&l.push(2);let u=new Uint8Array(2+l.length);u[0]=5,u[1]=l.length,u.set(l,2),await c(u);let p=await i.readExactly(2);if(!p||p[0]!==5)throw new Error("SOCKS5 \u63E1\u624B\u5931\u8D25\uFF1A\u975E\u6CD5\u54CD\u5E94");let d=p[1];if(d===2){let y=new TextEncoder().encode(o.username??""),w=new TextEncoder().encode(o.password??""),b=new Uint8Array(3+y.length+w.length);b[0]=1,b[1]=y.length,b.set(y,2),b[2+y.length]=w.length,b.set(w,3+y.length),await c(b);let S=await i.readExactly(2);if(!S||S[1]!==0)throw new Error("SOCKS5 \u7528\u6237\u540D/\u5BC6\u7801\u8BA4\u8BC1\u5931\u8D25")}else if(d!==0)throw new Error(`SOCKS5 \u4E0D\u652F\u6301\u7684\u8BA4\u8BC1\u65B9\u5F0F\uFF1A0x${d.toString(16)}`);let f=qn(r,n),x=new Uint8Array(3+f.length);x[0]=5,x[1]=1,x[2]=0,x.set(f,3),await c(x);let P=await i.readExactly(4);if(!P||P[0]!==5)throw new Error("SOCKS5 CONNECT \u54CD\u5E94\u975E\u6CD5");if(P[1]!==0)throw new Error(`SOCKS5 CONNECT \u5931\u8D25\uFF1A0x${P[1].toString(16)}`);let v=P[3];if(v===1)await i.readExactly(4);else if(v===3){let y=await i.readExactly(1);if(!y)throw new Error("SOCKS5 \u54CD\u5E94\u622A\u65AD");await i.readExactly(y[0])}else if(v===4)await i.readExactly(16);else throw new Error("SOCKS5 \u54CD\u5E94\u5730\u5740\u7C7B\u578B\u975E\u6CD5");return await i.readExactly(2),i.release()}finally{try{s.releaseLock()}catch{}}}function qn(t,e){if(X(t)){let o=t.split(".").map(s=>Number(s)),i=new Uint8Array(7);return i[0]=1,i.set(o,1),i[5]=e>>8&255,i[6]=e&255,i}if(ee(t)){let o=new Uint8Array(19);o[0]=4;let i=t.split(":").filter(Boolean);for(let s=0;s<8;s++){let c=parseInt(i[s]??"0",16)||0;o[1+s*2]=c>>8&255,o[2+s*2]=c&255}return o[17]=e>>8&255,o[18]=e&255,o}let r=new TextEncoder().encode(t),n=new Uint8Array(2+r.length+2);return n[0]=3,n[1]=r.length,n.set(r,2),n[n.length-2]=e>>8&255,n[n.length-1]=e&255,n}var Ze=[13,10,13,10];async function zr(t,e,r,n){let o=new ie(t),i=e.getWriter(),s=`${r}:${n}`;try{let c=[`CONNECT ${s} HTTP/1.1`,`Host: ${s}`,"Proxy-Connection: keep-alive","User-Agent: CFPilot/1.0","",""].join(`\r
`);await i.write(new TextEncoder().encode(c));let l=[];for(let f=0;f<8192;f++){let x=await o.readExactly(1);if(!x)break;l.push(x[0]);let P=l.length;if(P>=4&&l[P-4]===Ze[0]&&l[P-3]===Ze[1]&&l[P-2]===Ze[2]&&l[P-1]===Ze[3])break}let p=new TextDecoder().decode(new Uint8Array(l)).split(`\r
`)[0]??"",d=/^HTTP\/1\.[01]\s+(\d{3})/.exec(p);if(!d)throw new Error("HTTP \u4EE3\u7406\u54CD\u5E94\u975E\u6CD5");if(d[1]!=="200")throw new Error(`HTTP \u4EE3\u7406 CONNECT \u5931\u8D25\uFF1A${d[1]}`);return o.release()}finally{try{i.releaseLock()}catch{}}}ve();function Gr(t,e="direct"){let r=t.trim();if(!r)return null;let n=e,o=r,i=/^([a-z0-9+.-]+):\/\//i.exec(r);if(i){let d=i[1].toLowerCase();o=r.slice(i[0].length),d==="socks5"||d==="socks"||d==="socks5h"?n="socks5":(d==="http"||d==="https")&&(n="http")}let s=o.lastIndexOf("@"),c={};if(s>=0){let d=o.slice(0,s);o=o.slice(s+1);let f=d.indexOf(":");f>=0?c={username:d.slice(0,f),password:d.slice(f+1)}:c={username:d}}let l=o.lastIndexOf(":");if(l<0)return null;let u=o.slice(0,l).replace(/^\[|\]$/g,""),p=Number(o.slice(l+1));return!u||!Number.isInteger(p)||p<=0||p>65535?null:{host:u,port:p,kind:n,...c}}function Se(t,e="direct"){let r=[];for(let n of t.split(/[\n,;]+/)){let o=n.trim();if(!o)continue;let i=Gr(o,e);i&&r.push(i)}return r}var Ct=null;async function Kn(){return Ct||(Ct=(async()=>(await import("cloudflare"+":sockets")).connect)()),await Ct}var Zr=8e3;function ea(t,e){if(!X(t))return null;let r=t.split(".").map(s=>Number(s)),n=(r[0]<<8|r[1]).toString(16),o=(r[2]<<8|r[3]).toString(16);return`${e.replace(/:+$/,"")}::${n}:${o}`}async function je(t,e,r){let o=(await Kn())({hostname:t,port:e}),i,s=new Promise((c,l)=>{i=setTimeout(()=>l(new Error(`\u8FDE\u63A5\u8D85\u65F6\uFF1A${t}:${e}`)),r)});try{return await Promise.race([o.opened,s]),o}catch(c){try{await o.close()}catch{}throw c}finally{i&&clearTimeout(i)}}async function _r(t){let e=t.timeoutMs??Zr;try{let r=await je(t.hostname,t.port,e);return{readable:r.readable,writable:r.writable,via:"direct",endpoint:`${t.hostname}:${t.port}`}}catch(r){if(t.nat64&&X(t.hostname)){let n=ea(t.hostname,t.nat64);if(n){let o=await je(n,t.port,e);return{readable:o.readable,writable:o.writable,via:"nat64",endpoint:`${n}:${t.port}`}}}throw r}}async function ta(t,e){let r=t.timeoutMs??Zr;if(e.kind==="direct"){let o=await je(e.host,e.port,r);return{readable:o.readable,writable:o.writable,via:"direct",endpoint:`${e.host}:${e.port}`}}let n=await je(e.host,e.port,r);try{return e.kind==="http"?{readable:await zr(n.readable,n.writable,t.hostname,t.port),writable:n.writable,via:"http",endpoint:`${e.host}:${e.port}`}:{readable:await Wr(n.readable,n.writable,t.hostname,t.port,{username:e.username,password:e.password}),writable:n.writable,via:"socks5",endpoint:`${e.host}:${e.port}`}}catch(o){try{await n.close()}catch{}throw o}}async function ra(t,e){if(t.length===0)throw new Error("\u6CA1\u6709\u53EF\u7528\u7684\u51FA\u7AD9\u62E8\u53F7\u65B9\u5F0F");if(t.length===1||!e){let r=new Error("\u62E8\u53F7\u5931\u8D25");for(let n of t)try{return await n()}catch(o){r=o}throw r}return await new Promise((r,n)=>{let o=t.length,i=!1,s=[];for(let c of t)c().then(l=>{if(i){try{l.writable.getWriter().close()}catch{}return}i=!0,r(l)},l=>{s.push(l),o-=1,o===0&&!i&&(i=!0,n(s[0]??new Error("\u62E8\u53F7\u5931\u8D25")))})})}async function jr(t){let e=t.proxies??[],r=t.concurrent??!0;if(e.length===0)return await _r(t);let n=e.map(o=>()=>ta(t,o));return e.length>1&&n.push(()=>_r(t)),await ra(n,r)}async function Yr(t,e,r){let n=t.body;if(!n)return new Response("\u7F3A\u5C11\u8BF7\u6C42\u4F53",{status:400});let o=new ie(n),i=await Hr(o,e.uuid);if(!i)return new Response("VLESS \u5934\u89E3\u6790\u5931\u8D25",{status:400});if(i.header.command!==Fr)return new Response("XHTTP \u6682\u4E0D\u652F\u6301 UDP",{status:400});let s=await jr({hostname:i.header.hostname,port:i.header.port,proxies:r,nat64:e.nat64,concurrent:e.concurrentDial}),{readable:c,writable:l}=new TransformStream;gt(i.payload,s.writable),gt(s.readable,l);let u=i.header.addons;if(u.byteLength>255)return new Response("Addons \u957F\u5EA6\u8D85\u51FA VLESS \u534F\u8BAE\u4E0A\u9650",{status:400});let p=new Uint8Array(2+u.byteLength);p[0]=i.header.version,p[1]=u.byteLength,p.set(u,2);let d=new ReadableStream({start(x){x.enqueue(p),x.close()}}),f=new ReadableStream({async start(x){let P=d.getReader();for(;;){let{done:y,value:w}=await P.read();if(y)break;w&&x.enqueue(w)}P.releaseLock();let v=c.getReader();try{for(;;){let{done:y,value:w}=await v.read();if(y)break;w&&x.enqueue(w)}}finally{v.releaseLock(),x.close()}},cancel(x){c.cancel(x)}});return new Response(f,{status:200,headers:{"Content-Type":"text/event-stream","Cache-Control":"no-store","X-Accel-Buffering":"no"}})}function At(t){let e=[];return e.push(...Se(t.proxyIp,"direct")),e.push(...Se(t.socks5,"socks5")),e.push(...Se(t.httpProxy,"http")),e}async function Xr(t,e,r){let n=new URL(t.url);if(n.pathname==="/__edge_probe")return Le(t);let o=await mr(e),i=t.headers.get("Upgrade")?.toLowerCase();return n.pathname===o.wsPath?i!=="websocket"?fe("\u8BE5\u8DEF\u5F84\u9700\u8981 WebSocket \u5347\u7EA7",400):St(t,"vless",o,At(o),r):o.enableTrojan&&n.pathname===o.trojanPath?i!=="websocket"?fe("\u8BE5\u8DEF\u5F84\u9700\u8981 WebSocket \u5347\u7EA7",400):St(t,"trojan",o,At(o),r):o.enableXhttp&&n.pathname===o.xhttpPath?t.method!=="POST"?fe("XHTTP \u9700\u8981 POST \u8BF7\u6C42",405):await Yr(t,o,At(o)):null}var Oo={async fetch(t,e,r){try{return await hr(t,e)??await Xr(t,e,r)??lt(200)}catch{return lt(500)}}};export{Oo as default};
