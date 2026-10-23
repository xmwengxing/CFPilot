var ta=Object.defineProperty;var z=(t,e,r)=>()=>{if(r)throw r[0];try{return t&&(e=t(t=0)),e}catch(n){throw r=[n],n}};var nt=(t,e)=>{for(var r in e)ta(t,r,{get:e[r],enumerable:!0})};function ee(t){let e=new Uint8Array(t);crypto.getRandomValues(e);let r="";for(let n of e)r+=me[n>>4]+me[n&15];return r}function at(){let t=new Uint8Array(16);crypto.getRandomValues(t),t[6]=t[6]&15|64,t[8]=t[8]&63|128;let e=[];for(let r of t)e.push(me[r>>4]+me[r&15]);return[e.slice(0,4).join(""),e.slice(4,6).join(""),e.slice(6,8).join(""),e.slice(8,10).join(""),e.slice(10,16).join("")].join("-")}function rr(t){let e="abcdefghijklmnopqrstuvwxyz0123456789",r=new Uint8Array(t);crypto.getRandomValues(r);let n="";for(let a of r)n+=e[a%e.length];return n}function nr(t){let e=new TextEncoder().encode(t),r="",n=32768;for(let a=0;a<e.length;a+=n)r+=String.fromCharCode(...e.subarray(a,a+n));return btoa(r)}async function ar(t){let e=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(t)),r=new Uint8Array(e),n="";for(let a of r)n+=me[a>>4]+me[a&15];return n}function ot(t,e){if(t.length!==e.length)return!1;let r=0;for(let n=0;n<t.length;n++)r|=t.charCodeAt(n)^e.charCodeAt(n);return r===0}var me,he=z(()=>{"use strict";me="0123456789abcdef"});function ye(t,e){if(t==null)return e;let r=String(t).trim();if(r==="")return e;let n=Number(r);return Number.isFinite(n)?n:e}function te(t,e){if(t==null||t==="")return e;let r=String(t).trim().toLowerCase();return["1","true","yes","on"].includes(r)?!0:["0","false","no","off"].includes(r)?!1:e}function Y(t,e){return t==null?e:String(t)}function ra(t){return{uuid:Y(t.UUID,""),trojanPassword:Y(t.TROJAN_PASSWORD,""),wsPath:Y(t.WS_PATH||t.PATH,O.wsPath),trojanPath:O.trojanPath,xhttpPath:O.xhttpPath,add:Y(t.ADD,""),addApi:Y(t.ADDAPI,""),addCsv:Y(t.ADD_CSV,""),poolOfficial:te(t.OFFICIAL_IP,O.poolOfficial),officialCount:ye(t.OFFICIAL_IP_COUNT,O.officialCount),poolDomain:te(t.PREFERRED_DOMAIN,O.poolDomain),domainCount:ye(t.PREFERRED_DOMAIN_COUNT,O.domainCount),poolManual:te(t.MANUAL_IP,O.poolManual),poolCountries:Y(t.POOL_COUNTRIES,O.poolCountries),dls:ye(t.DLS,0),maxLatency:ye(t.MAX_LATENCY,0),maxNodes:0,proxyIp:Y(t.PROXYIP,""),socks5:Y(t.SOCKS5,""),httpProxy:Y(t.HTTP_PROXY,""),nat64:Y(t.NAT64,""),concurrentDial:te(t.TCP_CONCURRENT_DIAL,!0),resolvePreferred:te(t.RESOLVE_PREFERRED,O.resolvePreferred),relayPool:Y(t.RELAY_POOL,""),useBuiltinRelay:te(t.USE_BUILTIN_RELAY,O.useBuiltinRelay),enableTrojan:te(t.ENABLE_TROJAN??t.TROJAN,O.enableTrojan),enableXhttp:te(t.ENABLE_XHTTP??t.XHTTP,O.enableXhttp),subDomain:"",subProtocol:"both",subTransport:"both",subVariants:Y(t.SUB_VARIANTS,O.subVariants),clientFingerprint:O.clientFingerprint,ech:te(t.ECH,O.ech),echHost:Y(t.ECH_HOST,O.echHost),echDns:Y(t.ECH_DNS,O.echDns),tlsFragment:!1,tlsFragmentSize:O.tlsFragmentSize,tlsFragmentDelay:O.tlsFragmentDelay}}function ct(t,e){let r={...t};for(let[n,a]of Object.entries(e))if(a!=null)if(n==="dls"||n==="maxLatency"||n==="maxNodes"||n==="officialCount"||n==="domainCount")r[n]=ye(a,0);else if(n==="concurrentDial"||n==="resolvePreferred"||n==="useBuiltinRelay"||n==="enableTrojan"||n==="enableXhttp"||n==="tlsFragment"||n==="ech"||n==="poolOfficial"||n==="poolDomain"||n==="poolManual")r[n]=te(a,!1);else if(n==="subProtocol"){let i=String(a);r[n]=i==="vless"||i==="trojan"||i==="both"?i:"both"}else if(n==="subTransport"){let i=String(a);r[n]=i==="ws"||i==="xhttp"||i==="both"?i:"both"}else r[n]=String(a);return r}async function sr(t,e){let r=ra(e),n=await t.get(or),a={};if(n)try{a=JSON.parse(n)}catch{a={}}let i=ct(r,a),s=!1;return i.uuid||(i.uuid=at(),s=!0),i.trojanPassword||(i.trojanPassword=at().replace(/-/g,"").slice(0,16),s=!0),i.officialCount<1&&(i.officialCount=O.officialCount,s=!0),i.domainCount<1&&(i.domainCount=O.domainCount,s=!0),s&&await dt(t,i),i}async function dt(t,e){await t.put(or,JSON.stringify(e))}async function xe(t){return await t.get(ge)??""}async function pt(t){let e=await t.get(it);return e?e.split(/\r?\n/).map(r=>r.trim()).filter(r=>r.length>0):[]}async function lr(t,e){let r=e.map(n=>n.trim()).filter(n=>n.length>0);if(r.length===0){await t.delete(it);return}await t.put(it,r.join(`
`))}var or,ge,st,it,Ue,Re,Me,De,lt,ir,O,we=z(()=>{"use strict";he();or="CONFIG",ge="LOCAL_PREFERRED_IPS",st="SCANNER_TOKEN",it="POOL_DOMAIN_LIBRARY",Ue="ONETIME:",Re="SESSION:",Me="PANEL_PATH",De="ADMIN_PW_HASH",lt="ADMIN_PW_PLAIN",ir="/cfpilot",O={uuid:"",trojanPassword:"",wsPath:"/vless",trojanPath:"/trojan",xhttpPath:"/xhttp",add:"",addApi:"",addCsv:"",poolOfficial:!0,officialCount:20,poolDomain:!0,domainCount:10,poolManual:!1,poolCountries:"",dls:0,maxLatency:0,maxNodes:0,proxyIp:"",socks5:"",httpProxy:"",nat64:"",concurrentDial:!0,resolvePreferred:!0,relayPool:"",useBuiltinRelay:!0,enableTrojan:!0,enableXhttp:!0,subDomain:"",subProtocol:"vless",subTransport:"ws",subVariants:"vless-ws",clientFingerprint:"chrome",ech:!1,echHost:"cloudflare-ech.com",echDns:"",tlsFragment:!1,tlsFragmentSize:"10-20",tlsFragmentDelay:"10-20"}});function Z(t){let e=na.exec(t);if(!e)return!1;for(let r=1;r<=4;r++){let n=Number(e[r]);if(!Number.isInteger(n)||n<0||n>255)return!1}return!0}function X(t){return!t.includes(":")||!/^[0-9a-fA-F:.]+$/.test(t)?!1:aa(t)!==null}function aa(t){if(!t.includes(":"))return null;let e=t,r=e.lastIndexOf(":"),n=e.slice(r+1);if(n.includes(".")){if(!Z(n))return null;let p=n.split(".").map(f=>Number(f));e=`${e.slice(0,r+1)}${(p[0]<<8|p[1]).toString(16)}:${(p[2]<<8|p[3]).toString(16)}`}let a=e.indexOf("::"),i,s;if(a>=0){if(e.indexOf("::",a+1)>=0)return null;let p=e.slice(0,a),f=e.slice(a+2);i=p?p.split(":"):[],s=f?f.split(":"):[]}else i=e.split(":"),s=[];let c=i.length+s.length;if(c>8)return null;let d=[],u=p=>/^[0-9a-fA-F]{1,4}$/.test(p)?parseInt(p,16):null;for(let p of i){let f=u(p);if(f===null)return null;d.push(f)}let l=8-c;for(let p=0;p<l;p++)d.push(0);for(let p of s){let f=u(p);if(f===null)return null;d.push(f)}return d.length===8?d:null}function oa(t){let e=t.map(d=>(d&65535).toString(16)),r=-1,n=0,a=-1,i=0;for(let d=0;d<e.length;d++)e[d]==="0"?(a<0&&(a=d),i++,i>n&&(n=i,r=a)):(a=-1,i=0);if(n<2)return e.join(":");let s=e.slice(0,r).join(":"),c=e.slice(r+n).join(":");return`${s}::${c}`}function ia(t,e,r,n){if(e<0||e>=t.length)return null;if(r===1)return e+5>t.length?null:{hostname:`${t[e+1]}.${t[e+2]}.${t[e+3]}.${t[e+4]}`,next:e+5};if(n?r===2:r===3){if(e+2>t.length)return null;let a=t[e+1];return e+2+a>t.length?null:{hostname:new TextDecoder().decode(t.subarray(e+2,e+2+a)),next:e+2+a}}if(n?r===3:r===4){if(e+17>t.length)return null;let a=new DataView(t.buffer,t.byteOffset+e+1,16),i=[];for(let s=0;s<8;s++)i.push(a.getUint16(s*2,!1));return{hostname:oa(i),next:e+17}}return null}async function ut(t,e){let r=await t.peekExactly(1);if(!r)return null;let n=r[0],a;if(n===1)a=5;else if(e?n===2:n===3){let c=await t.peekExactly(2);if(!c)return null;a=2+c[1]}else if(e?n===3:n===4)a=17;else return null;let i=await t.peekExactly(a);if(!i)return null;let s=ia(i,0,n,e);return s?(t.skip(a),{hostname:s.hostname,addressType:n,consumed:a}):null}var na,se=z(()=>{"use strict";na=/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/});function Ve(t){return pr.get(t.toUpperCase())??""}function ur(t){return Object.prototype.hasOwnProperty.call(ft,t.toUpperCase())}var cr,Ne,ke,ft,dr,pr,fr,mt=z(()=>{"use strict";cr=["104.16.0.1","104.16.32.1","104.16.64.1","104.16.128.1","104.16.192.1","104.17.0.1","104.17.32.1","104.17.64.1","104.17.128.1","104.17.192.1","104.18.0.1","104.18.64.1","104.19.0.1","104.19.64.1","104.20.0.1","104.20.64.1","104.21.0.1","104.21.64.1","104.22.0.1","104.22.64.1","104.23.0.1","104.23.64.1","104.24.0.1","104.25.0.1","104.27.19.224","172.66.0.1","172.67.0.1"],Ne=["104.16.0.0/11","104.24.0.0/14","172.66.0.0/15"],ke=["cf.090227.xyz","bestcf.top","cloudflare.182682.xyz","speed.marisalnc.com","freeyx.cloudflare88.eu.org","cdn.2020111.xyz","cfip.cfcdn.vip","cf.0sm.com","cf.zhetengsha.eu.org","cloudflare.9jy.cc","cf.zerone-cdn.pp.ua","cfip.1323123.xyz","cnamefuckxxs.yuchen.icu","cloudflare-ip.mofashi.ltd","115155.xyz","cname.xirancdn.us","f3058171cad.002404.xyz","8.889288.xyz","cdn.tzpro.xyz","cf.877771.xyz","xn--b6gac.eu.org"],ft={HK:["HKG"],TW:["TPE","KHH"],JP:["NRT","KIX","CTS","FUK"],KR:["ICN","PUS"],SG:["SIN"],MY:["KUL"],TH:["BKK"],VN:["SGN","HAN"],ID:["CGK","DPS"],PH:["MNL"],IN:["BOM","MAA","DEL"],AU:["SYD","MEL","BNE","PER"],NZ:["AKL"],US:["LAX","SJC","SEA","ORD","DFW","IAD","EWR","ATL","MIA","DEN","PHX","BOS"],CA:["YYZ","YVR","YYC"],GB:["LHR","MAN"],DE:["FRA","MUC","BER"],FR:["CDG","MRS"],NL:["AMS"],IT:["MXP","FCO"],ES:["MAD","BCN"],SE:["ARN"],CH:["ZRH"],AT:["VIE"],PL:["WAW"],RU:["DME","SVO"],TR:["IST"],AE:["DXB"],IL:["TLV"],ZA:["JNB"],BR:["GRU","GIG"],AR:["EZE"],CL:["SCL"],MX:["MEX"]},dr={HK:"\u9999\u6E2F",TW:"\u53F0\u6E7E",JP:"\u65E5\u672C",KR:"\u97E9\u56FD",SG:"\u65B0\u52A0\u5761",MY:"\u9A6C\u6765\u897F\u4E9A",TH:"\u6CF0\u56FD",VN:"\u8D8A\u5357",ID:"\u5370\u5C3C",PH:"\u83F2\u5F8B\u5BBE",IN:"\u5370\u5EA6",AU:"\u6FB3\u5927\u5229\u4E9A",NZ:"\u65B0\u897F\u5170",US:"\u7F8E\u56FD",CA:"\u52A0\u62FF\u5927",GB:"\u82F1\u56FD",DE:"\u5FB7\u56FD",FR:"\u6CD5\u56FD",NL:"\u8377\u5170",IT:"\u610F\u5927\u5229",ES:"\u897F\u73ED\u7259",SE:"\u745E\u5178",CH:"\u745E\u58EB",AT:"\u5965\u5730\u5229",PL:"\u6CE2\u5170",RU:"\u4FC4\u7F57\u65AF",TR:"\u571F\u8033\u5176",AE:"\u963F\u8054\u914B",IL:"\u4EE5\u8272\u5217",ZA:"\u5357\u975E",BR:"\u5DF4\u897F",AR:"\u963F\u6839\u5EF7",CL:"\u667A\u5229",MX:"\u58A8\u897F\u54E5"},pr=new Map;for(let[t,e]of Object.entries(ft))for(let r of e)pr.set(r,t);fr=Object.keys(ft)});function gt(t){if(!/^\d{1,5}$/.test(t))return!1;let e=Number(t);return e>0&&e<=65535}function Fe(t,e=$e){let r=t.trim();if(!r||(r=r.replace(/^["']|["']$/g,"").trim(),!r||r.startsWith("#")))return null;let n="",a=r.indexOf("#");if(a>=0&&(n=r.slice(a+1).trim(),r=r.slice(0,a).trim()),!r)return null;if(r.startsWith("[")){let s=r.indexOf("]");if(s<0)return null;let c=r.slice(1,s),d=r.slice(s+1),u=e;if(d.startsWith(":")&&gt(d.slice(1)))u=Number(d.slice(1));else if(d)return null;return!X(c)&&!Z(c)?null:{ip:c,port:u,remark:n}}let i=(r.match(/:/g)??[]).length;if(i>1)return X(r)?{ip:r,port:e,remark:n}:null;if(i===1){let s=r.indexOf(":"),c=r.slice(0,s),d=r.slice(s+1);return!gt(d)||!Z(c)&&!X(c)&&!Oe(c)?null:{ip:c,port:Number(d),remark:n}}return!Z(r)&&!X(r)&&!Oe(r)?null:{ip:r,port:e,remark:n}}function Oe(t){return/^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/.test(t)}function sa(t){let e=t.split(/[_-]/).filter(Boolean),r="",n=0,a=0;if(e.length>=3){let i=Number(e[e.length-2]),s=Number(e[e.length-1]);Number.isFinite(i)&&Number.isFinite(s)&&(r=e.slice(0,e.length-2).join("_"),n=i,a=s)}else if(e.length===2){let i=Number(e[1]);Number.isFinite(i)&&(r=e[0]??"",n=i)}return{colo:r,latency:n,speed:a}}function bt(t,e){let r=sa(t.remark),n=r.colo.toUpperCase();return{ip:t.ip,port:t.port,remark:t.remark,colo:n,latency:r.latency,speed:r.speed,source:e,country:Ve(n)}}function la(t){let e=[];for(let r of t.split(/\r?\n/)){let n=Fe(r);n&&e.push(bt(n,"add"))}return e}function Pe(t){let e=[];for(let r of t.split(/\r?\n/)){let n=Fe(r);n&&e.push(bt(n,"local"))}return e}function ca(t){let e=[];for(let r of t.split(/\r?\n/)){let n=Fe(r);n&&e.push(bt(n,"addapi"))}return e}function ua(t,e){let r=t.trim().toLowerCase().replace(/[（(].*?[)）]/g,"");for(let n of e)if(r===n||r.includes(n))return 1;return 0}function Se(t,e){let r=-1,n=0;for(let a=0;a<t.length;a++){let i=ua(t[a],e);i>n&&(n=i,r=a)}return r}function ht(t){let e=t.replace(/[^\d.\-]/g,"");if(!e)return 0;let r=Number(e);return Number.isFinite(r)?r:0}function fa(t,e={}){let r=t.split(/\r?\n/).map(x=>x.trim()).filter(x=>x.length>0&&!x.startsWith("#")),n=[],a=0,i=!1,s=-1,c=-1,d=-1,u=-1,l=-1;if(r.length===0)return{entries:n,filtered:a,hasHeader:i};let p=br(r[0]),f=p.some(x=>Z(x.trim())||X(x.trim())),h=p.some(x=>mr.some(A=>x.toLowerCase().includes(A))||hr.some(A=>x.toLowerCase().includes(A))||gr.some(A=>x.toLowerCase().includes(A))),g=0;h&&!f&&(i=!0,s=Se(p,da),c=Se(p,pa),d=Se(p,mr),u=Se(p,hr),l=Se(p,gr),g=1);for(let x=g;x<r.length;x++){let A=br(r[x]);if(A.length===0)continue;let k="",T=$e,w=0,m=0,b="";if(i){if(s<0)continue;if(k=(A[s]??"").trim(),c>=0&&A[c]){let S=Number(A[c].trim());Number.isInteger(S)&&S>0&&S<=65535&&(T=S)}d>=0&&A[d]&&(w=ht(A[d])),u>=0&&A[u]&&(m=ht(A[u])),l>=0&&A[l]&&(b=A[l].trim())}else{let S=A.findIndex(D=>{let F=D.trim();return Z(F)||X(F)||F.includes(".")&&Oe(F)});if(S<0)continue;k=A[S].trim();let I=[];A.forEach((D,F)=>{if(F===S)return;let L=ht(D);D.trim()&&/[\d.]/.test(D)&&I.push({index:F,value:L,raw:D})}),I.length===1?w=I[0].value:I.length===2?(w=I[0].value,m=I[1].value):I.length===3?(gt(I[0].raw.trim())&&(T=I[0].value),w=I[1].value,m=I[2].value):(m=I[I.length-2].value,w=I[I.length-1].value);let M=A.find((D,F)=>F!==S&&D.trim()&&!/[\d.]/.test(D)&&/[a-zA-Z]/.test(D));M&&(b=M.trim())}if(!k)continue;let E=Fe(k.includes(":")&&!k.includes(" ")?k:`${k}:${T}`);if(!E)continue;let C={ip:E.ip,port:E.port,remark:b,colo:b.toUpperCase(),latency:m,speed:w,source:"addcsv",country:Ve(b.toUpperCase())};n.push(C)}let y=e.dls??0,P=e.maxLatency??0,v=n.filter(x=>!(y>0&&x.speed<y||P>0&&x.latency>P));return a=n.length-v.length,{entries:v,filtered:a,hasHeader:i}}function br(t){let e=[],r="",n=!1;for(let a=0;a<t.length;a++){let i=t[a];n?i==='"'?t[a+1]==='"'?(r+='"',a++):n=!1:r+=i:i==='"'?n=!0:i===","||i==="	"?(e.push(r.trim()),r=""):r+=i}return e.push(r.trim()),e}function Le(t){if(t<=1)return 0;let e=new Uint32Array(1);return crypto.getRandomValues(e),e[0]%t}function ma(t){let e=t.split(".");return(Number(e[0])<<24>>>0)+(Number(e[1])<<16)+(Number(e[2])<<8)+Number(e[3])}function ha(t){let e=t>>>0;return`${e>>>24&255}.${e>>>16&255}.${e>>>8&255}.${e&255}`}function ga(t,e){let r=[];for(let s of t){let[c,d]=s.split("/");if(!c||!Z(c))continue;let u=Number(d);!Number.isInteger(u)||u<8||u>32||r.push({base:ma(c),hostBits:32-u})}if(r.length===0||e<=0)return[];let n=new Set,a=e*24,i=0;for(;n.size<e&&i<a;){i++;let{base:s,hostBits:c}=r[Le(r.length)],d=2**c,u=c>=2?1+Le(d-2):Le(d);n.add(ha(s+u))}return[...n]}function ba(t,e=ke){let r=e.filter(n=>Oe(n));for(let n=r.length-1;n>0;n--){let a=Le(n+1),i=r[n];r[n]=r[a],r[a]=i}return r.slice(0,Math.max(0,Math.min(t,r.length)))}function va(t){let e=[],r=new Set,n=[...cr];for(let a=n.length-1;a>0;a--){let i=Math.floor(Math.random()*(a+1));[n[a],n[i]]=[n[i],n[a]]}for(let a of n){if(e.length>=t)break;r.has(a)||(r.add(a),e.push(a))}if(e.length<t)for(let a of ga(Ne,(t-e.length)*2)){if(e.length>=t)break;r.has(a)||(r.add(a),e.push(a))}return e.map(a=>({ip:a,port:$e,remark:"",colo:"",latency:0,speed:0,source:"official",country:""}))}function ya(t,e=ke){return ba(t,e).map(r=>({ip:r,port:$e,remark:"",colo:"",latency:0,speed:0,source:"domain",country:""}))}function xa(t){return[...new Set(t.split(/[,\s]+/).map(e=>e.trim().toUpperCase()).filter(e=>e.length===2&&ur(e)))]}function wa(t,e){if(e.length===0)return t;let r=new Set(e);return t.filter(n=>{let a=n.country||Ve(n.colo);return a!==""&&r.has(a)})}function Sa(t){let e=new Set,r=[],n=0;for(let a of t)for(let i of a.entries){let s=`${i.ip}:${i.port}`;if(e.has(s)){n++;continue}e.add(s),r.push(i)}return{nodes:r,deduped:n}}async function vr(t,e){let r=await fetch(t,{signal:AbortSignal.timeout(e),headers:{"User-Agent":"CFPilot/1.1 (+https://github.com/xmwengxing/CFPilot)"}});if(!r.ok)throw new Error(`HTTP ${r.status}`);return await r.text()}function yr(t,e,r){return Number.isFinite(t)?Math.min(r,Math.max(e,Math.trunc(t))):e}function xr(t){return t.filter(e=>e.entries.length>0).map(e=>({key:e.key,name:ka[e.key],entries:e.entries}))}async function He(t,e,r={}){let n=r.timeoutMs??6e3,a=r.budget,i=[],s=xa(t.poolCountries),c=t.poolOfficial||t.poolDomain||t.poolManual,d=c?t.poolOfficial?yr(t.officialCount,1,200):0:20,u=c?t.poolDomain?yr(t.domainCount,1,100):0:10,l=d>0?va(d):[],p=u>0?ya(u,r.domainPool):[],f=Pe(e),h=la(t.add),g=c?t.poolManual:!1,y=g?[...f,...h]:[];g&&y.length===0&&i.push("\u624B\u52A8\u4F18\u9009 IP \u4E3A\u7A7A\uFF1A\u8BF7\u5148\u8DD1\u4E00\u6B21\u672C\u5730\u771F\u8FDE\u63A5\u4F18\u9009\uFF0C\u6216\u5728\u300C\u624B\u52A8\u4F18\u9009\u300D\u91CC\u586B\u5165 IP");let P=[],v=t.addApi.split(/[\n,]+/).map(C=>C.trim()).filter(C=>/^https?:\/\//i.test(C));if(v.length>0&&!a?.exhausted){let C=await Promise.allSettled(v.map(S=>vr(S,n)));for(let S of C)S.status==="fulfilled"?P=P.concat(ca(S.value)):i.push(`ADDAPI \u62C9\u53D6\u5931\u8D25\uFF1A${String(S.reason?.message??S.reason)}`)}let x=[],A=0,k=t.addCsv.split(/[\n,]+/).map(C=>C.trim()).filter(C=>/^https?:\/\//i.test(C));if(k.length>0&&!a?.exhausted){let C=await Promise.allSettled(k.map(S=>vr(S,n)));for(let S of C)if(S.status==="fulfilled"){let I=fa(S.value,{dls:t.dls,maxLatency:t.maxLatency});x=x.concat(I.entries),A+=I.filtered}else i.push(`ADDCSV \u62C9\u53D6\u5931\u8D25\uFF1A${String(S.reason?.message??S.reason)}`)}a?.exhausted&&i.push("CPU \u9884\u7B97\u4E0D\u8DB3\uFF0C\u5DF2\u8DF3\u8FC7\u90E8\u5206\u8FDC\u7A0B\u62C9\u53D6");let T=[{key:"official",entries:l},{key:"domain",entries:p},{key:"manual",entries:y},{key:"api",entries:P},{key:"csv",entries:x}],w=xr(T);if(s.length>0&&w.length>0){let C=w.reduce((I,M)=>I+M.entries.length,0);w=w.map(I=>({...I,entries:wa(I.entries,s)})).filter(I=>I.entries.length>0);let S=w.reduce((I,M)=>I+M.entries.length,0);S===0?(w=xr(T),i.push(`\u56FD\u5BB6\u7B5B\u9009\uFF08${s.join("/")}\uFF09\u540E\u65E0\u53EF\u7528\u8282\u70B9\uFF1A\u968F\u673A\u4F18\u9009 IP \u7684\u673A\u623F\u672A\u77E5\uFF0C\u8BF7\u5148\u8DD1\u4E00\u6B21\u672C\u5730\u4F18\u9009\u518D\u6309\u56FD\u5BB6\u7B5B\u9009\uFF1B\u5DF2\u5FFD\u7565\u8BE5\u7B5B\u9009`)):S<C&&i.push(`\u56FD\u5BB6\u7B5B\u9009\uFF08${s.join("/")}\uFF09\u5DF2\u6392\u9664 ${C-S} \u6761\u673A\u623F\u672A\u77E5\u6216\u5730\u533A\u4E0D\u5339\u914D\u7684\u8282\u70B9`)}let{nodes:m,deduped:b}=Sa(w);return{nodes:t.maxNodes>0?m.slice(0,t.maxNodes):m,groups:w,stats:{official:l.length,domain:p.length,local:g?f.length:0,add:g?h.length:0,addapi:P.length,addcsv:x.length,filtered:A,deduped:b,countries:s,errors:i}}}function vt(t,e,r=wr){let n=String(t??"").split(/[,;\s]+/).map(c=>c.trim().toLowerCase()).filter(Boolean),i=wr.filter(c=>n.includes(c)).filter(c=>r.includes(c)?c==="trojan"?e.enableTrojan!==!1:c==="vless-xhttp"?e.enableXhttp!==!1:!0:!1);if(i.length>0)return i;let s=r.includes("vless-ws")?"vless-ws":r[0];return s?[s]:["vless-ws"]}function yt(t){return t.groups&&t.groups.length>0?t.groups:[{key:"official",name:"\u8282\u70B9",entries:t.nodes}]}function Ae(t,e,r,n=""){let a=t.remark&&!/^[\d.]+$/.test(t.remark)?t.remark:t.ip,i=t.colo&&t.colo!==a?` ${t.colo}`:"";return`${n?`${n} `:""}${a}${i} #${r+1}${e==="trojan"?" Trojan":""}`}function Pr(t){return t.includes(":")?`[${t}]`:t}function Ar(t){if(!t.config.ech)return"";let e=t.config.echHost.trim()||"cloudflare-ech.com",r=t.config.echDns.trim(),n=r?`${e}+${r}`:e;return`&ech=${encodeURIComponent(n)}`}function kr(t,e,r,n){let a=r==="xhttp"?e.config.xhttpPath:e.config.wsPath,i=new URLSearchParams;i.set("encryption","none"),i.set("security","tls"),i.set("sni",e.domain),i.set("type",r),i.set("host",e.domain),i.set("path",a),r==="xhttp"&&i.set("mode","stream-one");let s=encodeURIComponent(n??Ae(t,"vless",e.nodes.indexOf(t)));return`${["vle","ss"].join("")}://${e.config.uuid}@${Pr(t.ip)}:${t.port}?${i.toString()}${Ar(e)}#${s}`}function Pa(t,e,r){let n=new URLSearchParams;n.set("security","tls"),n.set("sni",e.domain),n.set("type","ws"),n.set("host",e.domain),n.set("path",e.config.trojanPath);let a=encodeURIComponent(r??Ae(t,"trojan",e.nodes.indexOf(t)));return`${["tro","jan"].join("")}://${encodeURIComponent(e.config.trojanPassword)}@${Pr(t.ip)}:${t.port}?${n.toString()}${Ar(e)}#${a}`}function K(t){return`"${t.replace(/\\/g,"\\\\").replace(/"/g,'\\"')}"`}function Aa(t){let e=[],r=[],n=[],a=vt(t.config.subVariants,t.config,Sr),i=a.some(p=>p==="vless-ws"),s=a.includes("trojan"),c=t.config.ech,d=t.config.echHost.trim()||"cloudflare-ech.com",u=t.config.echDns.trim(),l=()=>{if(!c)return[];let p=["    ech-opts:","      enable: true"];return p.push(`      query-server-name: ${K(d)}`),p};for(let p of yt(t))p.entries.forEach((f,h)=>{let g=`${p.name} ${Ae(f,"vless",h,"")}`;if(i&&(n.push(g),r.push([`  - name: ${K(g)}`,"    type: vless",`    uuid: ${t.config.uuid}`,`    server: ${f.ip}`,`    port: ${f.port}`,"    network: ws","    tls: true",`    servername: ${t.domain}`,`    client-fingerprint: ${t.config.clientFingerprint}`,...l(),"    ws-opts:",`      path: ${K(t.config.wsPath)}`,"      headers:",`        Host: ${t.domain}`].join(`
`))),s){let y=`${g} Trojan`;n.push(y),r.push([`  - name: ${K(y)}`,"    type: trojan",`    password: ${K(t.config.trojanPassword)}`,`    server: ${f.ip}`,`    port: ${f.port}`,"    network: ws","    tls: true",`    sni: ${t.domain}`,`    client-fingerprint: ${t.config.clientFingerprint}`,...l(),"    ws-opts:",`      path: ${K(t.config.trojanPath)}`,"      headers:",`        Host: ${t.domain}`].join(`
`))}});if(e.push("# CFPilot \u81EA\u52A8\u751F\u6210\u8BA2\u9605"),e.push("mixed-port: 7890"),e.push("allow-lan: false"),e.push("mode: rule"),e.push("log-level: info"),e.push("unified-delay: true"),e.push("tcp-concurrent: true"),e.push(""),e.push("dns:"),e.push("  enable: true"),e.push("  ipv6: false"),e.push("  enhanced-mode: fake-ip"),e.push("  fake-ip-range: 198.18.0.1/16"),e.push("  default-nameserver:"),e.push("    - 223.5.5.5"),e.push("    - 119.29.29.29"),e.push("  nameserver:"),e.push("    - https://223.5.5.5/dns-query"),e.push("    - https://dns.alidns.com/dns-query"),e.push("  fallback:"),e.push("    - 8.8.4.4"),e.push("    - 1.1.1.1"),e.push("  fallback-filter:"),e.push("    geoip: true"),e.push("    geoip-code: CN"),e.push(""),c&&(e.push("  nameserver-policy:"),e.push(`    ${K(d)}: ${u?K(u):"https://223.5.5.5/dns-query"}`),e.push("")),e.push("proxies:"),r.length===0?e.push("  []"):e.push(...r),e.push(""),e.push("proxy-groups:"),e.push('  - name: "CFPilot"'),e.push("    type: select"),e.push("    proxies:"),e.push('      - "\u81EA\u52A8\u9009\u62E9"'),e.push('      - "\u6545\u969C\u8F6C\u79FB"'),n.length===0)e.push("      []");else for(let p of n)e.push(`      - ${K(p)}`);if(n.length>0){e.push(""),e.push('  - name: "\u81EA\u52A8\u9009\u62E9"'),e.push("    type: url-test"),e.push('    url: "http://www.gstatic.com/generate_204"'),e.push("    interval: 300"),e.push("    tolerance: 50"),e.push("    proxies:");for(let p of n)e.push(`      - ${K(p)}`);e.push(""),e.push('  - name: "\u6545\u969C\u8F6C\u79FB"'),e.push("    type: fallback"),e.push('    url: "http://www.gstatic.com/generate_204"'),e.push("    interval: 300"),e.push("    proxies:");for(let p of n)e.push(`      - ${K(p)}`)}return e.push(""),e.push("rules:"),e.push("  - GEOIP,CN,DIRECT"),e.push("  - MATCH,CFPilot"),e.push(""),e.join(`
`)}function Ca(t){let e=[],r=[],n=vt(t.config.subVariants,t.config,Sr),a=n.some(l=>l==="vless-ws"),i=n.includes("trojan"),s=t.config.ech,c=t.config.echHost.trim()||"cloudflare-ech.com",d=()=>s?{ech:{enabled:!0,query_server_name:c}}:{};for(let l of yt(t)){let p=[];l.entries.forEach((f,h)=>{let g=`${l.name} ${Ae(f,"vless",h,"")}`,y=`${g} Trojan`;a&&p.push(g),i&&p.push(y),a&&e.push({type:"vless",tag:g,server:f.ip,server_port:f.port,uuid:t.config.uuid,tls:{enabled:!0,server_name:t.domain,insecure:!1,utls:{enabled:!0,fingerprint:t.config.clientFingerprint},...d()},transport:{type:"ws",path:t.config.wsPath,headers:{Host:t.domain}}}),i&&e.push({type:"trojan",tag:y,server:f.ip,server_port:f.port,password:t.config.trojanPassword,tls:{enabled:!0,server_name:t.domain,insecure:!1,utls:{enabled:!0,fingerprint:t.config.clientFingerprint},...d()},transport:{type:"ws",path:t.config.trojanPath,headers:{Host:t.domain}}})}),p.length>0&&r.push({tag:l.name,members:p})}e.push({type:"direct",tag:"direct"});for(let l of r)e.push({type:"selector",tag:l.tag,outbounds:l.members,default:l.members[0]});return e.push({type:"selector",tag:"CFPilot",outbounds:r.length>0?r.map(l=>l.tag):["direct"],default:r.length>0?r[0].tag:"direct"}),JSON.stringify({log:{level:"info",timestamp:!0},dns:{servers:[{tag:"dns-out",address:"https://1.1.1.1/dns-query"},{tag:"local",address:"local"}],rules:[{rule_set:[],server:"dns-out"}]},inbounds:[{type:"mixed",tag:"mixed-in",listen:"127.0.0.1",listen_port:2080}],outbounds:e,route:{rules:[{domain_suffix:[".cn"],outbound:"direct"}],final:"CFPilot",auto_detect_interface:!0}},null,2)}function Ia(t){let e=[],r=vt(t.config.subVariants,t.config);for(let n of yt(t))n.entries.forEach((a,i)=>{let s=Ae(a,"vless",i,n.name);for(let c of r)c==="vless-ws"?e.push(kr(a,t,"ws",`${s} WS`)):c==="vless-xhttp"?e.push(kr(a,t,"xhttp",`${s} XHTTP`)):e.push(Pa(a,t,`${s} Trojan`))});return nr(e.join(`
`))}function Cr(t,e){switch(t){case"clash":return{body:Aa(e),contentType:"text/yaml; charset=utf-8",fileName:"CFPilot.yaml"};case"singbox":return{body:Ca(e),contentType:"application/json; charset=utf-8",fileName:"CFPilot.json"};default:return{body:Ia(e),contentType:"text/plain; charset=utf-8",fileName:"CFPilot.txt"}}}var $e,da,pa,mr,hr,gr,ka,wr,Sr,xt=z(()=>{"use strict";se();he();mt();$e=443;da=["ip\u5730\u5740","ip \u5730\u5740","ip","\u5730\u5740","\u670D\u52A1\u5668","server","host"],pa=["\u7AEF\u53E3","port"],mr=["\u4E0B\u8F7D\u901F\u5EA6","\u901F\u5EA6","speed","download"],hr=["\u5E73\u5747\u5EF6\u8FDF","\u5EF6\u8FDF","latency","delay","\u54CD\u5E94\u65F6\u95F4","rtt"],gr=["colo","\u673A\u623F","\u6570\u636E\u4E2D\u5FC3","\u5730\u533A","region"];ka={official:"\u5B98\u65B9\u4F18\u9009IP",domain:"\u4F18\u9009\u57DF\u540D",manual:"\u624B\u52A8\u4F18\u9009IP",api:"\u8FDC\u7A0BAPI",csv:"\u6D4B\u901FCSV"};wr=["vless-ws","vless-xhttp","trojan"];Sr=["vless-ws","trojan"]});async function Pt(t,e){return await ar(`${e}:${t}`)}function Ur(t){return`/${t.trim().replace(/^\/+/,"")}`}async function Mr(t,e,r){let n=await t.get(Me)??"",a=r&&r.trim()?Ur(r):"";a?n!==a&&(n=a,await t.put(Me,n)):n||(n=Ur(`${ir}-${rr(6)}`),await t.put(Me,n));let i=await t.get(De)??"",s=null,c=e&&e.trim()?e.trim():"";if(c){let d=ee(8);i=`${d}:${await Pt(c,d)}`,await t.put(De,i),await t.delete(lt)}else if(!i){let d=`cfp-${ee(8)}`,u=ee(8);i=`${u}:${await Pt(d,u)}`,await t.put(De,i),s=d,await t.put(lt,d)}return{panelPath:n,passwordHash:i,generatedPassword:s}}async function Dr(t,e){let[r,n]=t.passwordHash.split(":");if(!r||!n)return!1;let a=await Pt(e,r);return ot(a,n)}function Nr(t){let e=t.headers.get("Cookie")??"",r={};for(let n of e.split(";")){let a=n.indexOf("=");if(a<0)continue;let i=n.slice(0,a).trim(),s=n.slice(a+1).trim();i&&(r[i]=decodeURIComponent(s))}return r}async function Vr(t){let e=ee(24);return await t.put(`${Re}${e}`,JSON.stringify({ua:"",t:Date.now()}),Rr),e}async function At(t,e){let r=Nr(e)[We];return r?!!await t.get(`${Re}${r}`):!1}function Lr(t,e=Rr){return`${We}=${t}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${e}`}function Or(){return`${We}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`}async function $r(t,e){let r=Nr(e)[We];r&&await t.delete(`${Re}${r}`)}async function Fr(t){let e=ee(20);return await t.put(`${Ue}${e}`,"1",Ra),e}async function Hr(t,e){if(!e)return!1;let r=await t.get("SCANNER_TOKEN");return r&&ot(r,e)?!0:await t.get(`${Ue}${e}`)?(await t.delete(`${Ue}${e}`),!0):!1}var We,Rr,Ra,Ct=z(()=>{"use strict";we();he();We="cfpilot_sess",Rr=3600*24,Ra=600});async function Ut(t,e,r,n=!0){let a=t.getReader(),i=e.getWriter();try{for(;!r?.exhausted;){let{done:s,value:c}=await a.read();if(s)break;!c||c.byteLength===0||await i.write(c)}}catch{}finally{if(n)try{await i.close()}catch{}else try{i.releaseLock()}catch{}try{a.releaseLock()}catch{}}}var Ze,Rt=z(()=>{"use strict";Ze=class{start=performance.now();limitMs;constructor(e=8){this.limitMs=e}get elapsedMs(){return performance.now()-this.start}get exhausted(){return this.elapsedMs>this.limitMs}get remainingMs(){return this.limitMs-this.elapsedMs}check(){if(this.exhausted)throw new Error(`CPU \u9884\u7B97\u8D85\u9650\uFF08${this.limitMs}ms\uFF09\uFF0C\u5DF2\u63D0\u524D\u4E2D\u6B62`)}}});var Wr={};nt(Wr,{API_PREFIX:()=>Mt,getScannerToken:()=>Na,handleApi:()=>Va});function J(t,e=200,r={}){return new Response(JSON.stringify(t),{status:e,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store",...r}})}function re(t,e){return J({ok:!1,error:t},e)}async function Na(t,e){let r=await t.get(st);if(r)return r;if(typeof e.SCANNER_TOKEN=="string"&&e.SCANNER_TOKEN)return e.SCANNER_TOKEN;let n=ee(24);return await t.put(st,n),n}async function Va(t,e,r){if(!e.pathname.startsWith(Mt))return null;let{store:n,env:a,config:i,auth:s}=r,c=e.pathname.slice(Mt.length)||"/",d=t.method.toUpperCase();if(c==="/session"&&d==="GET"){let l=await At(n,t);return J({ok:!0,authenticated:l,panelPath:s.panelPath})}if(c==="/login"&&d==="POST"){let l="";try{let h=await t.json();l=String(h.password??"")}catch{return re("\u8BF7\u6C42\u4F53\u89E3\u6790\u5931\u8D25",400)}if(!l)return re("\u8BF7\u8F93\u5165\u5BC6\u7801",400);if(!await Dr(s,l))return re("\u5BC6\u7801\u9519\u8BEF",401);let f=await Vr(n);return J({ok:!0},200,{"Set-Cookie":Lr(f)})}if(c==="/logout"&&d==="POST")return await $r(n,t),J({ok:!0},200,{"Set-Cookie":Or()});if(c==="/preferred-ips"&&d==="POST"){let l=t.headers.get("Authorization")??"",p=l.startsWith("Bearer ")?l.slice(7).trim():l.trim();if(!await Hr(n,p))return re("Token \u6821\u9A8C\u5931\u8D25",401);let h;try{h=await t.json()}catch{return re("\u8BF7\u6C42\u4F53\u89E3\u6790\u5931\u8D25",400)}let g=Array.isArray(h.ips)?h.ips.map(P=>String(P)):[],y=g.map(P=>P.trim()).filter(P=>P.length>0).join(`
`);return await n.put(ge,y),J({ok:!0,count:g.length})}if(!await At(n,t))return re("\u672A\u767B\u5F55\u6216\u4F1A\u8BDD\u5DF2\u8FC7\u671F",401);if(c==="/status"&&d==="GET"){let l=await xe(n),p=Pe(l);return J({ok:!0,panelPath:s.panelPath,domain:e.hostname,colo:t.cf?.colo??"UNK",localIps:p.length,generatedPassword:s.generatedPassword,version:"0.1.0"})}if(c==="/config"&&d==="GET")return J({ok:!0,config:i});if(c==="/config"&&d==="PUT"){let l;try{l=await t.json()}catch{return re("\u8BF7\u6C42\u4F53\u89E3\u6790\u5931\u8D25",400)}if(!l.config||typeof l.config!="object")return re("\u7F3A\u5C11\u914D\u7F6E\u5BF9\u8C61",400);let p=ct(i,l.config);return await dt(n,p),r.onConfigChanged(),J({ok:!0,config:p})}if(c==="/ips"&&d==="GET"){let l=await xe(n),p=Pe(l);return J({ok:!0,raw:l,count:p.length,entries:p})}if(c==="/ips"&&d==="DELETE")return await n.delete(ge),J({ok:!0});if(c==="/nodes"&&d==="GET"){let l=new Ze(8),p=await xe(n),f=await pt(n),h=await He(i,p,{budget:l,domainPool:f.length>0?f:void 0});return J({ok:!0,count:h.nodes.length,nodes:h.nodes.slice(0,200),groups:h.groups.map(g=>({key:g.key,name:g.name,count:g.entries.length})),stats:h.stats})}if(c==="/pool/meta"&&d==="GET"){let l=await pt(n);return J({ok:!0,countries:fr.map(p=>({code:p,name:dr[p]??p})),limits:{officialCount:200,domainCount:100},builtin:{cidrs:Ne.length,domains:ke.length},customDomains:l})}if(c==="/pool/library"&&d==="PUT"){let l;try{l=await t.json()}catch{return re("\u8BF7\u6C42\u4F53\u89E3\u6790\u5931\u8D25",400)}let p=Array.isArray(l.domains)?l.domains.map(f=>String(f)):[];return await lr(n,p),J({ok:!0,count:p.filter(f=>f.trim()).length})}if(c==="/scanner-token"&&d==="POST"){let l=await Fr(n);return J({ok:!0,token:l,expiresIn:600})}return c==="/events"&&d==="GET"?await La(t,n):re("\u63A5\u53E3\u4E0D\u5B58\u5728",404)}async function La(t,e){let r=new TextEncoder,n="",a,i=new ReadableStream({async start(s){let c=()=>{a&&clearTimeout(a);try{s.close()}catch{}};t.signal.addEventListener("abort",c);let d=async()=>{try{let u=await xe(e);if(u!==n){n=u;let l=Pe(u).length;s.enqueue(r.encode(`event: ips
data: ${JSON.stringify({count:l})}

`))}else s.enqueue(r.encode(`: keepalive

`))}catch{}t.signal.aborted||(a=setTimeout(()=>{d()},3e3))};await d()},cancel(){a&&clearTimeout(a)}});return new Response(i,{status:200,headers:{"Content-Type":"text/event-stream; charset=utf-8","Cache-Control":"no-store",Connection:"keep-alive","X-Accel-Buffering":"no"}})}var Mt,Gr=z(()=>{"use strict";Ct();we();xt();mt();he();Rt();Mt="/api/v1"});function yn(t){let e=t.replace(/-/g,"").trim().toLowerCase();if(!/^[0-9a-f]{32}$/.test(e))return null;let r=new Uint8Array(16);for(let n=0;n<16;n++)r[n]=parseInt(e.slice(n*2,n*2+2),16);return r}function gn(t){let e="";for(let r of t)e+=hn[r>>4]+hn[r&15];return e}async function xn(t,e){let r=await t.readExactly(1);if(!r)return null;let n=await t.readExactly(16);if(!n)return null;let a=yn(e);if(!a||gn(n)!==gn(a))return null;let i=await t.readExactly(1);if(!i)return null;let s=i[0],c=s>0?await t.readExactly(s):new Uint8Array(0);if(!c)return null;let d=await t.readExactly(1);if(!d)return null;let u=await t.readExactly(2);if(!u)return null;let l=await ut(t,!0);if(!l)return null;let p=u[0]<<8|u[1];return{header:{version:r[0],command:d[0],port:p,hostname:l.hostname,addressType:l.addressType,addons:c},payload:t.release()}}function wn(t,e){if(t.byteLength<18)return null;let r=yn(e);if(!r)return null;for(let u=0;u<16;u++)if(t[1+u]!==r[u])return null;let n=t[17],a=18+n;if(t.byteLength<a+4)return null;let i=t[a];a+=1;let s=t[a]<<8|t[a+1];a+=2;let c=t[a];a+=1;let d="";if(c===1){if(t.byteLength<a+4)return null;d=`${t[a]}.${t[a+1]}.${t[a+2]}.${t[a+3]}`,a+=4}else if(c===2){if(t.byteLength<a+1)return null;let u=t[a];if(a+=1,t.byteLength<a+u)return null;d=new TextDecoder().decode(t.subarray(a,a+u)),a+=u}else if(c===3){if(t.byteLength<a+16)return null;let u=[];for(let l=0;l<8;l++)u.push((t[a+l*2]<<8|t[a+l*2+1]).toString(16));d=u.join(":"),a+=16}else return null;return{header:{version:t[0],command:i,port:s,hostname:d,addressType:c,addons:t.subarray(18,18+n)},consumed:a}}var bn,vn,hn,$t=z(()=>{"use strict";se();bn=1,vn=2,hn="0123456789abcdef"});function ne(t,e){return t>>>e|t<<32-e}function no(t){let e=new Uint32Array([3238371032,914150663,812702999,4144912697,4290775857,1750603025,1694076839,3204075428]),r=t.length*8,n=Math.ceil((t.length+9)/64)*64,a=new Uint8Array(n);a.set(t),a[t.length]=128;let i=new DataView(a.buffer);i.setUint32(n-8,Math.floor(r/4294967296),!1),i.setUint32(n-4,r>>>0,!1);let s=new Uint32Array(64);for(let d=0;d<n;d+=64){for(let v=0;v<16;v++)s[v]=i.getUint32(d+v*4,!1);for(let v=16;v<64;v++){let x=ne(s[v-15],7)^ne(s[v-15],18)^s[v-15]>>>3,A=ne(s[v-2],17)^ne(s[v-2],19)^s[v-2]>>>10;s[v]=s[v-16]+x+s[v-7]+A>>>0}let u=e[0],l=e[1],p=e[2],f=e[3],h=e[4],g=e[5],y=e[6],P=e[7];for(let v=0;v<64;v++){let x=ne(h,6)^ne(h,11)^ne(h,25),A=h&g^~h&y,k=P+x+A+ro[v]+s[v]>>>0,T=ne(u,2)^ne(u,13)^ne(u,22),w=u&l^u&p^l&p,m=T+w>>>0;P=y,y=g,g=h,h=f+k>>>0,f=p,p=l,l=u,u=k+m>>>0}e[0]=e[0]+u>>>0,e[1]=e[1]+l>>>0,e[2]=e[2]+p>>>0,e[3]=e[3]+f>>>0,e[4]=e[4]+h>>>0,e[5]=e[5]+g>>>0,e[6]=e[6]+y>>>0,e[7]=e[7]+P>>>0}let c=new Uint8Array(28);for(let d=0;d<7;d++)c[d*4]=e[d]>>>24&255,c[d*4+1]=e[d]>>>16&255,c[d*4+2]=e[d]>>>8&255,c[d*4+3]=e[d]&255;return c}function Sn(t){let e=no(t),r="";for(let n of e)r+=kn[n>>4]+kn[n&15];return r}var ro,kn,Pn=z(()=>{"use strict";ro=new Uint32Array([1116352408,1899447441,3049323471,3921009573,961987163,1508970993,2453635748,2870763221,3624381080,310598401,607225278,1426881987,1925078388,2162078206,2614888103,3248222580,3835390401,4022224774,264347078,604807628,770255983,1249150122,1555081692,1996064986,2554220882,2821834349,2952996808,3210313671,3336571891,3584528711,113926993,338241895,666307205,773529912,1294757372,1396182291,1695183700,1986661051,2177026350,2456956037,2730485921,2820302411,3259730800,3345764771,3516065817,3600352804,4094571909,275423344,430227734,506948616,659060556,883997877,958139571,1322822218,1537002063,1747873779,1955562222,2024104815,2227730452,2361852424,2428436474,2756734187,3204031479,3329325298]),kn="0123456789abcdef"});function ao(t){return Sn(new TextEncoder().encode(t))}function Cn(t,e){if(t.byteLength<58)return null;let r=ao(e);if(new TextDecoder().decode(t.subarray(0,56)).trim().toLowerCase()!==r||t[56]!==13||t[57]!==10)return null;let a=58;if(t.byteLength<a+2)return null;let i=t[a];a+=1;let s=t[a];a+=1;let c="";if(s===1){if(t.byteLength<a+4)return null;c=`${t[a]}.${t[a+1]}.${t[a+2]}.${t[a+3]}`,a+=4}else if(s===3){if(t.byteLength<a+1)return null;let u=t[a];if(a+=1,t.byteLength<a+u)return null;c=new TextDecoder().decode(t.subarray(a,a+u)),a+=u}else if(s===4){if(t.byteLength<a+16)return null;let u=[];for(let l=0;l<8;l++)u.push((t[a+l*2]<<8|t[a+l*2+1]).toString(16));c=u.join(":"),a+=16}else return null;if(t.byteLength<a+4)return null;let d=t[a]<<8|t[a+1];return a+=2,t[a]!==13||t[a+1]!==10?null:(a+=2,{header:{command:i,port:d,hostname:c,addressType:s},consumed:a})}var An,In=z(()=>{"use strict";se();Pn();An=3});function Ft(t,e){if(t.byteLength===0)return e;if(e.byteLength===0)return t;let r=new Uint8Array(new ArrayBuffer(t.byteLength+e.byteLength));return r.set(t,0),r.set(e,t.byteLength),r}var ce,Ie=z(()=>{"use strict";ce=class{reader;chunks=[];size=0;done=!1;constructor(e){this.reader=e.getReader()}async readExactly(e){if(e===0)return new Uint8Array(0);for(;this.size<e;){if(this.done)return null;let{done:r,value:n}=await this.reader.read();if(r)return this.done=!0,this.size>=e?this.take(e):null;n&&n.byteLength>0&&(this.chunks.push(n),this.size+=n.byteLength)}return this.take(e)}take(e){let r=new Uint8Array(e),n=0;for(;n<e;){let a=this.chunks[0],i=e-n;a.byteLength<=i?(r.set(a,n),n+=a.byteLength,this.chunks.shift()):(r.set(a.subarray(0,i),n),this.chunks[0]=a.subarray(i),n+=i)}return this.size-=e,r}async peekExactly(e){if(e===0)return new Uint8Array(0);for(;this.size<e;){if(this.done)return null;let{done:r,value:n}=await this.reader.read();if(r)return this.done=!0,this.size>=e?this.slice(e):null;n&&n.byteLength>0&&(this.chunks.push(n),this.size+=n.byteLength)}return this.slice(e)}skip(e){return this.size<e?null:this.take(e)}slice(e){let r=new Uint8Array(e),n=0;for(let a of this.chunks){if(n>=e)break;let i=Math.min(a.byteLength,e-n);r.set(a.subarray(0,i),n),n+=i}return r}peek(){if(this.chunks.length===0)return new Uint8Array(0);let e=this.chunks.reduce((a,i)=>a+i.byteLength,0),r=new Uint8Array(e),n=0;for(let a of this.chunks)r.set(a,n),n+=a.byteLength;return r}release(){let e=this.peek();this.chunks=[],this.size=0;let r=this.reader,n=this,a=!1;return new ReadableStream({async pull(i){if(!a&&(a=!0,e.byteLength>0)){i.enqueue(e);return}if(n.done){i.close();return}try{let{done:s,value:c}=await r.read();s?(n.done=!0,i.close()):c&&c.byteLength>0&&i.enqueue(c)}catch(s){i.error(s)}},cancel(i){r.cancel(i)}})}}});async function ue(t,e,r,n){let a=Date.now()+r,i=await Promise.race([t.readExactly(e),new Promise(s=>setTimeout(()=>s(null),Math.max(1,a-Date.now())))]);if(i===null)throw new Error(`${n}\u8D85\u65F6\uFF08${r}ms \u65E0\u54CD\u5E94\uFF09`);return i}async function Tn(t,e,r,n,a={}){let i=new ce(t),s=e.getWriter(),c=a.handshakeTimeoutMs??oo,d=async u=>{await s.write(u)};try{let u=[0];a.username&&u.push(2);let l=new Uint8Array(2+u.length);l[0]=5,l[1]=u.length,l.set(u,2),await d(l);let p=await ue(i,2,c,"SOCKS5 \u63E1\u624B");if(!p||p[0]!==5)throw new Error("SOCKS5 \u63E1\u624B\u5931\u8D25\uFF1A\u975E\u6CD5\u54CD\u5E94");let f=p[1];if(f===2){let v=new TextEncoder().encode(a.username??""),x=new TextEncoder().encode(a.password??""),A=new Uint8Array(3+v.length+x.length);A[0]=1,A[1]=v.length,A.set(v,2),A[2+v.length]=x.length,A.set(x,3+v.length),await d(A);let k=await ue(i,2,c,"SOCKS5 \u8BA4\u8BC1");if(!k||k[1]!==0)throw new Error("SOCKS5 \u7528\u6237\u540D/\u5BC6\u7801\u8BA4\u8BC1\u5931\u8D25")}else if(f!==0)throw new Error(`SOCKS5 \u4E0D\u652F\u6301\u7684\u8BA4\u8BC1\u65B9\u5F0F\uFF1A0x${f.toString(16)}`);let h=io(r,n),g=new Uint8Array(3+h.length);g[0]=5,g[1]=1,g[2]=0,g.set(h,3),await d(g);let y=await ue(i,4,c,"SOCKS5 CONNECT");if(!y||y[0]!==5)throw new Error("SOCKS5 CONNECT \u54CD\u5E94\u975E\u6CD5");if(y[1]!==0)throw new Error(`SOCKS5 CONNECT \u5931\u8D25\uFF1A0x${y[1].toString(16)}`);let P=y[3];if(P===1)await ue(i,4,c,"SOCKS5 \u54CD\u5E94");else if(P===3){let v=await ue(i,1,c,"SOCKS5 \u54CD\u5E94");if(!v)throw new Error("SOCKS5 \u54CD\u5E94\u622A\u65AD");await ue(i,v[0],c,"SOCKS5 \u54CD\u5E94")}else if(P===4)await i.readExactly(16);else throw new Error("SOCKS5 \u54CD\u5E94\u5730\u5740\u7C7B\u578B\u975E\u6CD5");return await ue(i,2,c,"SOCKS5 \u54CD\u5E94"),i.release()}finally{try{s.releaseLock()}catch{}}}function io(t,e){if(Z(t)){let a=t.split(".").map(s=>Number(s)),i=new Uint8Array(7);return i[0]=1,i.set(a,1),i[5]=e>>8&255,i[6]=e&255,i}if(X(t)){let a=new Uint8Array(19);a[0]=4;let i=t.split(":").filter(Boolean);for(let s=0;s<8;s++){let c=parseInt(i[s]??"0",16)||0;a[1+s*2]=c>>8&255,a[2+s*2]=c&255}return a[17]=e>>8&255,a[18]=e&255,a}let r=new TextEncoder().encode(t),n=new Uint8Array(2+r.length+2);return n[0]=3,n[1]=r.length,n.set(r,2),n[n.length-2]=e>>8&255,n[n.length-1]=e&255,n}var oo,En=z(()=>{"use strict";Ie();se();oo=6e3});async function Un(t,e,r,n,a={}){let i=new ce(t),s=e.getWriter(),c=`${r}:${n}`;try{let d=a.username&&a.password?`Proxy-Authorization: Basic ${btoa(`${a.username}:${a.password}`)}\r
`:"",u=[`CONNECT ${c} HTTP/1.1`,`Host: ${c}`,"Proxy-Connection: keep-alive","User-Agent: CFPilot/1.0",d,"",""].join(`\r
`);await s.write(new TextEncoder().encode(u));let l=[],p=Date.now()+Ht;for(let y=0;y<8192;y++){if(Date.now()>p)throw new Error(`HTTP \u4EE3\u7406\u63E1\u624B\u8D85\u65F6\uFF08${Ht}ms \u65E0\u54CD\u5E94\uFF09`);let P=await Promise.race([i.readExactly(1),new Promise(x=>setTimeout(()=>x(null),Math.max(1,p-Date.now())))]);if(!P){let x=await Promise.race([i.readExactly(1),new Promise(A=>setTimeout(()=>A(null),200))]);if(!x)throw new Error(`HTTP \u4EE3\u7406\u63E1\u624B\u8D85\u65F6\uFF08${Ht}ms \u65E0\u54CD\u5E94\uFF09`);l.push(x[0]);continue}l.push(P[0]);let v=l.length;if(v>=4&&l[v-4]===Je[0]&&l[v-3]===Je[1]&&l[v-2]===Je[2]&&l[v-1]===Je[3])break}let h=new TextDecoder().decode(new Uint8Array(l)).split(`\r
`)[0]??"",g=/^HTTP\/1\.[01]\s+(\d{3})/.exec(h);if(!g)throw new Error("HTTP \u4EE3\u7406\u54CD\u5E94\u975E\u6CD5");if(g[1]!=="200")throw new Error(`HTTP \u4EE3\u7406 CONNECT \u5931\u8D25\uFF1A${g[1]}`);return i.release()}finally{try{s.releaseLock()}catch{}}}var Je,Ht,Rn=z(()=>{"use strict";Ie();Je=[13,10,13,10],Ht=6e3});function co(t){return/^\d{1,3}(\.\d{1,3}){3}$/.test(t)?!0:t.includes(":")&&/^[0-9a-fA-F:.]+$/.test(t)}function po(t,e){let r=t.trim(),n=/^\[([^\]]+)\](?::(\d+))?$/.exec(r);if(n)return{host:n[1],port:Number(n[2]??e)};if(r.includes(":")&&r.split(":").length>2)return{host:r,port:e};let a=r.lastIndexOf(":");if(a<0)return{host:r,port:e};let i=r.slice(0,a),s=Number(r.slice(a+1));return i?{host:i,port:Number.isInteger(s)&&s>0?s:e}:{host:r,port:e}}async function uo(t,e,r,n=Dn){try{let a=`${t}?name=${encodeURIComponent(e)}&type=${r}`,i=await fetch(a,{headers:{accept:"application/dns-json"},signal:AbortSignal.timeout(n)});if(!i.ok)return[];let s=await i.json();if(!s||s.Status!==0||!Array.isArray(s.Answer))return[];let c=r==="TXT"?16:r==="A"?1:28;return s.Answer.filter(d=>d.type===c).map(d=>String(d.data))}catch{return[]}}async function zt(t,e,r={}){for(let n of so){if(r.deadline!==void 0&&Date.now()>=r.deadline)break;let a=r.timeoutMs??Dn,i=r.deadline!==void 0?r.deadline-Date.now():Number.POSITIVE_INFINITY,s=Math.max(50,Math.min(a,i)),c=await uo(n,t,e,s);if(c.length>0)return c}return[]}function fo(t,e){let r=[],n=String(t).replace(/^"|"$/g,"").replace(/\\010/g,",").replace(/\\n/g,",").trim();if(!n||n==="@edgetunnel")return r;let a=n.split(/[,;\s]+/).filter(Boolean);if(a.length===0)return r;for(let i of a){let s=i.trim();if(!s)continue;let{host:c,port:d}=po(s,e);if(!Z(c)&&!X(c))return[];r.push({hostname:c,port:d})}return r}async function qe(t,e,r={}){let n=t.trim();if(!n)return[];if(co(n))return[{hostname:n,port:e}];let a=`${n}:${e}`,i=Mn.get(a);if(i&&Date.now()-i.at<lo)return i.ips;let s=[];if(!r.skipTxt){let u=await zt(n,"TXT",r);for(let l of u){let p=fo(l,e);if(p.length>0){s.push(...p);break}if(String(l).replace(/^"|"$/g,"").replace(/\\010/g,",").trim()==="@edgetunnel")break}}if(s.length===0){let u=await zt(n,"A",r);for(let l of u)Z(l)&&s.push({hostname:l,port:e})}if(s.length===0){let u=await zt(n,"AAAA",r);for(let l of u)X(l)&&s.push({hostname:l,port:e})}let c=[],d=new Set;for(let u of s){let l=`${u.hostname}:${u.port}`;d.has(l)||(d.add(l),c.push(u))}return c.length>0&&Mn.set(a,{at:Date.now(),ips:c}),c}var so,Dn,lo,Mn,_t=z(()=>{"use strict";se();so=["https://cloudflare-dns.com/dns-query","https://dns.alidns.com/resolve","https://doh.pub/dns-query"],Dn=4e3,lo=300*1e3,Mn=new Map});function Ln(t){let e=String(t??"").toUpperCase();return e?ho[e]??(/^[A-Z]{2}$/.test(e)?e:"US"):"US"}async function Vn(t,e=443,r=On,n={}){let a=t.trim();if(!a)return[];let i=`${a}:${e}:${r}`,s=Nn.get(i);if(s&&Date.now()-s.at<vo)return s.ips;let c=a,d=e,u=(a.match(/:/g)??[]).length;if(u===1){let p=/^(.*):(\d{1,5})$/.exec(a);p&&(c=p[1],d=Number(p[2]))}else if(u>1&&a.startsWith("[")){let p=/^\[([^\]]+)\]:(\d{1,5})$/.exec(a);p&&(c=p[1],d=Number(p[2]))}let l=[];if(Z(c)||X(c))l=[{ip:c,port:Number.isInteger(d)&&d>0?d:e,label:a}];else try{l=(await qe(c,d,{skipTxt:n.skipTxt,deadline:n.deadline,timeoutMs:n.timeoutMs})).slice(0,r).map(f=>({ip:f.hostname,port:f.port,label:`${c} \u2192 ${f.hostname}`}))}catch{l=[]}return l.length>0&&Nn.set(i,{at:Date.now(),ips:l}),l}function yo(t,e=$n){let r=Ln(t),n=a=>{let i=Qe[a];return i?i===r?0:Object.keys(Qe).findIndex(d=>Qe[d]===i)+1:999};return mo.map((a,i)=>({d:a,i,rank:n(a)})).sort((a,i)=>a.rank!==i.rank?a.rank-i.rank:a.i-i.i).map(a=>a.d).slice(0,Math.max(0,e))}async function Fn(t={}){let e=t.perDomain??On,r=[],n=new Set,a=h=>{for(let g of h){let y=`${g.ip}:${g.port}`;n.has(y)||(n.add(y),r.push(g))}},i=(t.userEntries??"").trim(),s=i?i.split(/[\n,;]+/).map(h=>h.trim()).filter(Boolean):[],c=t.domainLimit??$n,d=t.useBuiltin!==!1?yo(t.colo,c):[],u=h=>t.perDomain!==void 0?e:Qe[h]===Ln(t.colo)?go:bo,l=await Promise.all([...s.map(h=>Vn(h,443,e,{deadline:t.deadline,timeoutMs:t.timeoutMs})),...d.map(h=>Vn(h,443,u(h),{skipTxt:!0,deadline:t.deadline,timeoutMs:t.timeoutMs}))]);for(let h=0;h<s.length;h++)a(l[h]);let p=l.slice(s.length),f=p.reduce((h,g)=>Math.max(h,g.length),0);for(let h=0;h<f;h++)for(let g of p)h<g.length&&a([g[h]]);return r}var Qe,mo,ho,On,Te,$n,go,bo,vo,Nn,Hn=z(()=>{"use strict";se();_t();Qe={"proxyip.hk.cmliussss.net":"HK","proxyip.us.cmliussss.net":"US","proxyip.sg.cmliussss.net":"SG","proxyip.jp.cmliussss.net":"JP","proxyip.kr.cmliussss.net":"KR","proxyip.de.cmliussss.net":"DE","proxyip.se.cmliussss.net":"SE","proxyip.nl.cmliussss.net":"NL","proxyip.fi.cmliussss.net":"FI","proxyip.gb.cmliussss.net":"GB","proxyip.oracle.cmliussss.net":"Oracle","proxyip.digitalocean.cmliussss.net":"DigitalOcean","proxyip.vultr.cmliussss.net":"Vultr","proxyip.multacom.cmliussss.net":"Multacom"},mo=["proxyip.hk.cmliussss.net","proxyip.jp.cmliussss.net","proxyip.sg.cmliussss.net","proxyip.us.cmliussss.net","proxyip.de.cmliussss.net","proxyip.gb.cmliussss.net","proxyip.kr.cmliussss.net","proxyip.nl.cmliussss.net","proxyip.se.cmliussss.net","proxyip.fi.cmliussss.net","proxyip.oracle.cmliussss.net","proxyip.digitalocean.cmliussss.net","proxyip.vultr.cmliussss.net","proxyip.multacom.cmliussss.net"],ho={HKG:"HK",SYD:"AU",MEL:"AU",BNE:"AU",PER:"AU",ADL:"AU",CBR:"AU",SIN:"SG",NRT:"JP",HND:"JP",KIX:"JP",TYO:"JP",OSA:"JP",NGO:"JP",CTS:"JP",FUK:"JP",OKA:"JP",ICN:"KR",SEL:"KR",PUS:"KR",FRA:"DE",MUC:"DE",DUS:"DE",BER:"DE",HAM:"DE",STR:"DE",VIE:"DE",ZRH:"DE",CDG:"FR",MAD:"ES",MXP:"IT",FCO:"IT",PRG:"CZ",WAW:"PL",ARN:"SE",AMS:"NL",HEL:"FI",LHR:"GB",LGW:"GB",MAN:"GB",EDI:"GB",LAX:"US",SJC:"US",SFO:"US",SEA:"US",PDX:"US",SAN:"US",LAS:"US",PHX:"US",SLC:"US",DEN:"US",DFW:"US",IAH:"US",AUS:"US",ORD:"US",MSP:"US",DTW:"US",STL:"US",MCI:"US",ATL:"US",MIA:"US",MCO:"US",BNA:"US",CLT:"US",IAD:"US",BOS:"US",EWR:"US",JFK:"US",PHL:"US",YYZ:"CA",YVR:"CA",YUL:"CA",MEX:"MX",GRU:"BR",TPE:"TW",KHH:"TW",TSA:"TW",RMQ:"TW"};On=4,Te=8,$n=3,go=2,bo=1,vo=30*1e3,Nn=new Map});function zn(t){let e=t.split(".");if(e.length!==4)return null;let r=0;for(let n of e){if(!/^\d{1,3}$/.test(n))return null;let a=Number(n);if(a>255)return null;r=r*256+a}return r>>>0}function ve(t){let e=zn(t);if(e===null)return!1;for(let[r,n]of xo){let a=zn(r);if(a===null)continue;let i=n===0?0:4294967295<<32-n>>>0;if((e&i)===(a&i))return!0}return!1}function _n(t){let e=[],r=new Set,n=l=>{let p=`${l.source}|${l.host}|${l.port}`;r.has(p)||(r.add(p),e.push(l))};for(let l of t.proxies??[])l.kind==="direct"?n({source:"proxy",host:l.host,port:l.port,label:`ProxyIP ${l.host}:${l.port}`,via:{kind:"direct",host:l.host,port:l.port}}):n({source:"proxy",host:l.host,port:l.port,label:`${l.kind.toUpperCase()} ${l.host}:${l.port}`,via:{kind:l.kind,host:l.host,port:l.port,username:l.username,password:l.password,serverName:l.serverName}});let i=ve(t.targetHost)||t.deprioritizeDirect===!0;n({source:"direct",host:t.targetHost,port:t.targetPort,label:`\u76F4\u8FDE ${t.targetHost}:${t.targetPort}`,deprioritized:i});let s=t.optimizedIps??[],c=s.filter(l=>!ve(l.ip)),d=s.filter(l=>ve(l.ip));for(let l of c)n({source:"optimized",host:l.ip,port:l.port,label:`\u4F18\u9009 ${l.ip}:${l.port}`});for(let l of d)n({source:"optimized",host:l.ip,port:l.port,label:`\u4F18\u9009 ${l.ip}:${l.port}\uFF08Cloudflare \u7F51\u6BB5\uFF0C\u53EF\u80FD\u4E0D\u53EF\u8FBE\uFF09`,deprioritized:!0});let u=t.relay??[];for(let l of u)n({source:"relay",host:l.ip,port:l.port,label:`\u53CD\u4EE3 ${l.label}`,deprioritized:!t.relayAsPrimary});return e.map((l,p)=>({candidate:l,index:p})).sort((l,p)=>{let f=+!!l.candidate.deprioritized-+!!p.candidate.deprioritized;return f!==0?f:l.index-p.index}).map(l=>l.candidate)}function Wn(t){let e=t.filter(r=>!r.deprioritized);return{proxy:e.filter(r=>r.source==="proxy"),direct:e.filter(r=>r.source!=="proxy"),fallback:t.filter(r=>r.deprioritized)}}function Gn(t,e){let r=t instanceof Error?t.message:String(t);return/proxy request failed|cannot connect to the specified address|TCP Loop/i.test(r)?{kind:"blocked",message:r,candidate:e}:/timeout|超时|timed out|abort/i.test(r)?{kind:"timeout",message:r,candidate:e}:{kind:"other",message:r,candidate:e}}function Zn(t){switch(t.kind){case"blocked":return`\u51FA\u7AD9\u88AB Cloudflare \u62D2\u7EDD\uFF08${t.candidate}\uFF09\uFF1A${t.message}
  \u5E38\u89C1\u539F\u56E0\uFF1A\u76EE\u6807\u5730\u5740\u5728 Cloudflare \u81EA\u5BB6\u7F51\u6BB5\uFF08Worker \u4E0D\u80FD\u4E3B\u52A8\u8FDE\u56DE CF \u81EA\u5DF1\u7684\u5165\u53E3\uFF09\u3002
  \u2192 \u6362\u4E00\u4E2A\u7B2C\u4E09\u65B9 IP\uFF0C\u6216\u6539\u7528\u4EE3\u7406\u843D\u5730\u3002`;case"timeout":return`\u51FA\u7AD9\u8D85\u65F6\uFF08${t.candidate}\uFF09\uFF1A${t.message}
  \u2192 \u8BE5\u5730\u5740\u5F53\u524D\u4E0D\u53EF\u8FBE\uFF0C\u53EF\u6362\u4E00\u6761\u5019\u9009\u6216\u542F\u7528\u4EE3\u7406\u843D\u5730\u3002`;default:return`\u51FA\u7AD9\u5931\u8D25\uFF08${t.candidate}\uFF09\uFF1A${t.message}`}}var xo,Wt=z(()=>{"use strict";xo=[["104.16.0.0",13],["104.24.0.0",14],["104.31.0.0",15],["172.64.0.0",13],["162.158.0.0",15],["188.114.96.0",20],["141.101.64.0",18],["108.162.192.0",18],["103.21.244.0",22],["103.22.200.0",22],["103.31.4.0",22],["131.0.72.0",22],["197.234.240.0",22],["198.41.128.0",17],["192.0.0.0",24],["192.0.2.0",24],["192.88.99.0",24],["199.27.128.0",21],["223.5.5.0",24],["1.0.0.0",24],["1.1.1.0",24]]});function jn(t,e="direct"){let r=t.trim();if(!r)return null;let n=e,a=r,i=/^([a-z0-9+.-]+):\/\//i.exec(r);if(i){let h=i[1].toLowerCase();a=r.slice(i[0].length),h==="socks5"||h==="socks"||h==="socks5h"?n="socks5":h==="https"?n="https":h==="http"&&(n="http")}let s=a.lastIndexOf("@"),c={};if(s>=0){let h=a.slice(0,s);a=a.slice(s+1);let g=h.indexOf(":");g>=0?c={username:h.slice(0,g),password:h.slice(g+1)}:c={username:h}}let d,u=/#sni=([^/#]+)/i.exec(a);u&&(d=u[1].trim(),a=a.slice(0,u.index)+a.slice(u.index+u[0].length));let l=a.lastIndexOf(":");if(l<0)return null;let p=a.slice(0,l).replace(/^\[|\]$/g,""),f=Number(a.slice(l+1));return!p||!Number.isInteger(f)||f<=0||f>65535?null:(!d&&n==="https"&&!wo(p)&&(d=p),{host:p,port:f,kind:n,...c,...d?{serverName:d}:{}})}function wo(t){return/^\d{1,3}(\.\d{1,3}){3}$/.test(t)}function Ee(t,e="direct"){let r=[];for(let n of t.split(/[\n,;]+/)){let a=n.trim();if(!a)continue;let i=jn(a,e);i&&r.push(i)}return r}var Gt=z(()=>{"use strict"});async function ko(){return Zt||(Zt=(async()=>(await import("cloudflare"+":sockets")).connect)()),await Zt}function Po(t,e){if(!Z(t))return null;let r=t.split(".").map(s=>Number(s)),n=(r[0]<<8|r[1]).toString(16),a=(r[2]<<8|r[3]).toString(16);return`${e.replace(/:+$/,"")}::${n}:${a}`}async function Ke(t,e,r,n,a){let s=(await ko())({hostname:t,port:e},n?{secureTransport:n}:void 0),c=async(u,l)=>{let p,f=new Promise((h,g)=>{p=setTimeout(()=>g(new Error(`${l}\u8D85\u65F6\uFF1A${t}:${e}`)),r)});try{return await Promise.race([u,f])}finally{p&&clearTimeout(p)}},d;try{if(await c(s.opened,"\u8FDE\u63A5"),n==="starttls"){if(d=s.startTls?.(a?{expectedServerHostname:a}:void 0),!d)throw new Error("\u5F53\u524D\u8FD0\u884C\u65F6\u4E0D\u652F\u6301 startTls");return await c(d.opened,"TLS \u63E1\u624B"),d}return s}catch(u){try{await(d??s).close()}catch{}throw u}}async function Ao(t){let e=t.timeoutMs??Yt;try{let r=await Ke(t.hostname,t.port,e);return{readable:r.readable,writable:r.writable,via:"direct",endpoint:`${t.hostname}:${t.port}`}}catch(r){if(t.nat64&&Z(t.hostname)){let n=Po(t.hostname,t.nat64);if(n){let a=await Ke(n,t.port,e);return{readable:a.readable,writable:a.writable,via:"nat64",endpoint:`${n}:${t.port}`}}}throw r}}async function Co(t,e){let r=t.timeoutMs??Yt;if(e.kind==="direct"){let i=await Ke(e.host,e.port,r);return{readable:i.readable,writable:i.writable,via:"direct",endpoint:`${e.host}:${e.port}`}}let n=e.kind==="https"?"starttls":void 0,a=await Ke(e.host,e.port,r,n,e.kind==="https"?e.serverName:void 0);try{return e.kind==="http"||e.kind==="https"?{readable:await Un(a.readable,a.writable,t.hostname,t.port,{username:e.username,password:e.password}),writable:a.writable,via:e.kind,endpoint:`${e.host}:${e.port}`}:{readable:await Tn(a.readable,a.writable,t.hostname,t.port,{username:e.username,password:e.password}),writable:a.writable,via:"socks5",endpoint:`${e.host}:${e.port}`}}catch(i){try{await a.close()}catch{}throw i}}async function jt(t,e){if(t.length===0)throw new Error("\u6CA1\u6709\u53EF\u7528\u7684\u51FA\u7AD9\u62E8\u53F7\u65B9\u5F0F");if(t.length===1||!e){let r=new Error("\u62E8\u53F7\u5931\u8D25");for(let n of t)try{return await n()}catch(a){r=a}throw r}return await new Promise((r,n)=>{let a=t.length,i=!1,s=[];for(let c of t)c().then(d=>{if(i){try{d.writable.getWriter().close()}catch{}return}i=!0,r(d)},d=>{s.push(d),a-=1,a===0&&!i&&(i=!0,n(s[0]??new Error("\u62E8\u53F7\u5931\u8D25")))})})}async function Yn(t,e){let r=[...t];if(!e)return r;try{let n=await Fn(e),a=new Set(r.map(i=>`${i.ip}:${i.port}`));for(let i of n){let s=`${i.ip}:${i.port}`;a.has(s)||(a.add(s),r.push(i))}}catch{}return r}async function Io(t,e,r){if(t.length===0)return null;for(let n=0;n<t.length;n+=Te){let i=t.slice(n,n+Te).map(s=>e({source:"relay",host:s.ip,port:s.port,label:`\u53CD\u4EE3 ${s.label}`}));try{return await jt(i,r)}catch{}}return null}async function et(t){let e=t.proxies??[],r=t.concurrent??!0,n=t.budgetMs??So,a=Date.now()+n,i=[...t.optimizedIps??[]],s=!1;if(t.resolvePreferred)try{let k=await qe(t.hostname,t.port,{deadline:a});if(k.length>0){s=!0;for(let T of k)i.push({ip:T.hostname,port:T.port})}}catch{}let c=ve(t.hostname),d=s&&i.length>0&&i.every(k=>ve(k.ip)),u=[...t.relay??[]],l=d||c;l&&t.relayPool&&(u=await Yn(u,{...t.relayPool,deadline:a}));let p=l?u.slice(0,Te):[],f=l?u.slice(Te):[],h=_n({targetHost:t.hostname,targetPort:t.port,optimizedIps:i,proxies:e,deprioritizeDirect:c||d,relay:p,relayAsPrimary:p.length>0});if(h.length===0)throw new Error("\u6CA1\u6709\u53EF\u7528\u7684\u51FA\u7AD9\u62E8\u53F7\u65B9\u5F0F");let g=k=>async()=>{let T=a-Date.now();if(T<=0)throw new Error(`\u62E8\u53F7\u9884\u7B97\u5DF2\u7528\u5C3D\uFF08${n}ms\uFF09\uFF1A${t.hostname}:${t.port}`);let w=Math.max(200,Math.min(t.timeoutMs??Yt,T)),m={...t,timeoutMs:w};try{return k.source==="proxy"&&k.via?await Co(m,{host:k.via.host,port:k.via.port,kind:k.via.kind,username:k.via.username,password:k.via.password,serverName:k.via.serverName}):await Ao({...m,hostname:k.host,port:k.port})}catch(b){let E=Gn(b,k.label);throw t.onFailure?.(E),b}},y=Wn(h),{proxy:P,direct:v,fallback:x}=y;if(P.length>0){let k=P.map(g);try{return await jt(k,r)}catch(T){if(x.length===0)throw T;for(let w of x)try{return await g(w)()}catch{}throw T}}let A=v.map(g);try{return await jt(A,r)}catch(k){let T=f;T.length===0&&t.relayPool&&(T=await Yn([],{...t.relayPool,deadline:a}));let w=await Io(T,g,r);if(w)return w;if(x.length===0)throw k;for(let m of x)try{return await g(m)()}catch{}throw k}}var Zt,Yt,So,Bt=z(()=>{"use strict";En();Rn();se();_t();Hn();Wt();Gt();Zt=null;Yt=8e3,So=15e3});var qn={};nt(qn,{handleWebSocket:()=>Xt,recentDiagnostics:()=>Ro,recordDiagnostics:()=>Jn,truncateCloseReason:()=>Xn});function Xn(t,e=123){let r=new TextEncoder;if(r.encode(t).length<=e)return t;let n=t.slice(0,e);for(;r.encode(n).length>e;)n=n.slice(0,-1);n=n.replace(/\uFFFD+$/,"");let a="\u2026";for(;n.length>0&&r.encode(n+a).length>e;)n=n.slice(0,-1);return n+a}function Jn(t,e,r){tt.unshift({at:Date.now(),target:t,failures:e,summary:r}),tt.length>Bn&&(tt.length=Bn)}function Ro(){return tt}async function Xt(t,e,r,n,a,i){let[s,c]=Object.values(new WebSocketPair);try{c.accept({allowHalfOpen:!0})}catch{c.accept()}c.binaryType="arraybuffer";let d=new Uint8Array(0),u=!1,l=null,p=null,f=null,h=w=>{try{c.send(w)}catch{}},g=w=>{let m=new Uint8Array(2+w.byteLength);m[0]=0,m[1]=w.byteLength,m.set(w,2),h(m)},y=(w,m)=>{try{c.close(w,Xn(m))}catch{}},P=()=>{if(f&&(clearTimeout(f),f=null),l)try{l.writable.close()}catch{}},v=async()=>{if(!l)return;let w=l.readable.getReader();try{for(;;){let{done:m,value:b}=await w.read();if(m)break;b&&b.byteLength>0&&h(b)}}catch{}finally{try{w.releaseLock()}catch{}y(1e3,"done")}},x=async w=>{if(p)try{await p.write(w)}catch{P()}},A=w=>{if(e==="vless"){let b=wn(w,r.uuid);return b?{command:b.header.command,port:b.header.port,hostname:b.header.hostname,headerLength:b.consumed}:null}let m=Cn(w,r.trojanPassword);return m?{command:m.header.command,port:m.header.port,hostname:m.header.hostname,headerLength:m.consumed}:null},k=async w=>{let m=A(d);if(!m){w||(f=setTimeout(()=>{f=null,k(!0).catch(I=>y(1011,String(I)))},Mo));return}if(f&&(clearTimeout(f),f=null),u)return;u=!0;let b=e==="vless"?vn:An;if(m.command===b){y(1002,"UDP over WebSocket \u6682\u4E0D\u652F\u6301");return}g(new Uint8Array(0));let E=[],C=null;try{l=await et({hostname:m.hostname,port:m.port,proxies:n,timeoutMs:To,concurrent:r.concurrentDial,nat64:r.nat64||void 0,resolvePreferred:r.resolvePreferred,relayPool:{userEntries:r.relayPool||void 0,useBuiltin:r.useBuiltinRelay,colo:typeof t.cf?.colo=="string"?t.cf.colo:void 0},onFailure:I=>{E.push(I),i?.failures.push(I)}})}catch(I){C=I}if(!l){let I=E.length>0?E.map(M=>Zn(M)).join(`
`):`\u51FA\u7AD9\u8FDE\u63A5\u5931\u8D25\uFF1A${String(C)}`;Jn(`${m.hostname}:${m.port}`,E,I),y(1011,I);return}p=l.writable.getWriter();let S=d.byteLength>m.headerLength?d.slice(m.headerLength):new Uint8Array(0);S.byteLength>0&&await x(S),d=new Uint8Array(0),a?.waitUntil(v())};c.addEventListener("message",w=>{(async()=>{let m=w.data,b=typeof m=="string"?new TextEncoder().encode(m):new Uint8Array(m);if(b.byteLength!==0){if(!u){if(d=Ft(d,b),d.byteLength>Eo){y(1009,"\u63E1\u624B\u5934\u8D85\u8FC7 64KB");return}await k(!1);return}if(!p){if(d=Ft(d,b),d.byteLength>Uo){y(1009,"\u62E8\u53F7\u671F\u95F4\u6570\u636E\u8FC7\u591A");return}return}await x(b)}})()});let T=()=>{P()};c.addEventListener("close",T),c.addEventListener("error",T);try{return new Response(null,{status:101,webSocket:s})}catch(w){return console.error("[\u81EA\u7814\u6570\u636E\u9762] 101 \u54CD\u5E94\u6784\u9020\u5931\u8D25\uFF1A",w),new Response(null,{status:200})}}var To,Eo,Uo,tt,Bn,Mo,Jt=z(()=>{"use strict";$t();In();Ie();Bt();Wt();To=5e3,Eo=64*1024,Uo=8*1024*1024;tt=[],Bn=20;Mo=80});var Kn={};nt(Kn,{handleXhttp:()=>Kt,recentXhttpDiagnostics:()=>Do,recordXhttpDiagnostics:()=>Qn});function Qn(t,e,r){rt.unshift({at:Date.now(),target:t,...e,summary:r}),rt.length>20&&(rt.length=20)}function Do(){return rt}async function Kt(t,e,r){let n=t.body;if(!n)return new Response("\u7F3A\u5C11\u8BF7\u6C42\u4F53",{status:400});let a=new ce(n),i=await xn(a,e.uuid);if(!i)return new Response("VLESS \u5934\u89E3\u6790\u5931\u8D25",{status:400});if(i.header.command!==bn)return new Response("XHTTP \u6682\u4E0D\u652F\u6301 UDP",{status:400});let s=await et({hostname:i.header.hostname,port:i.header.port,proxies:r,nat64:e.nat64,concurrent:e.concurrentDial,resolvePreferred:e.resolvePreferred,relayPool:{userEntries:e.relayPool||void 0,useBuiltin:e.useBuiltinRelay},onFailure:g=>{Qn(`${i.header.hostname}:${i.header.port}`,g,`XHTTP \u51FA\u7AD9\u5931\u8D25\uFF08${g.candidate}\uFF09\uFF1A${g.message}`)}}),{readable:c,writable:d}=new TransformStream;Ut(i.payload,s.writable,void 0,!1),Ut(s.readable,d);let u=i.header.addons;if(u.byteLength>255)return new Response("Addons \u957F\u5EA6\u8D85\u51FA VLESS \u534F\u8BAE\u4E0A\u9650",{status:400});let l=new Uint8Array(2+u.byteLength);l[0]=i.header.version,l[1]=u.byteLength,l.set(u,2);let p=!1,f=null,h=new ReadableStream({start(g){g.enqueue(l),p=!0},async pull(g){if(p){f||(f=c.getReader());try{let{done:y,value:P}=await f.read();if(y){g.close();return}P&&P.byteLength>0&&g.enqueue(P)}catch{try{g.close()}catch{}}}},cancel(g){c.cancel(g)}});return new Response(h,{status:200,headers:{"Content-Type":"text/event-stream","Cache-Control":"no-store","X-Accel-Buffering":"no"}})}var rt,er=z(()=>{"use strict";Ie();$t();Rt();Bt();rt=[]});we();xt();he();var Ta=15*1024*1024,Ea=2*1024*1024;async function ze(t){let e=new URL(t.url);if(t.headers.get("Upgrade")?.toLowerCase()==="websocket"){let d=new WebSocketPair,[u,l]=Object.values(d);return l.accept(),l.addEventListener("message",p=>{let f=typeof p.data=="string"?p.data:"";if(f==="PING"||f==="ping"){l.send(JSON.stringify({pong:!0,colo:t.cf?.colo??"UNK",clientIp:t.headers.get("CF-Connecting-IP")??""}));try{l.close(1e3,"Probe complete")}catch{}}}),new Response(null,{status:101,webSocket:u})}let n=Number.parseInt(e.searchParams.get("bytes")??"",10),a=Number.isFinite(n)&&n>0?Math.min(n,Ta):Ea,i=new Uint8Array(64*1024);for(let d=0;d<i.length;d++)i[d]=97;let s=0,c=new ReadableStream({pull(d){if(s>=a){d.close();return}let u=Math.min(i.byteLength,a-s);d.enqueue(i.subarray(0,u)),s+=u}});return new Response(c,{status:200,headers:{"Content-Type":"application/octet-stream","Cache-Control":"no-store","Access-Control-Allow-Origin":"*","X-Probe-Bytes":String(a),"X-Probe-Nonce":ee(4)}})}var Ir="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";var _e=null;function Ua(t){let e=atob(t),r=new Uint8Array(new ArrayBuffer(e.length));for(let n=0;n<e.length;n++)r[n]=e.charCodeAt(n);return r}async function Tr(){if(_e!==null)return _e;let t=Ua(Ir),e=new Response(t).body;if(!e)throw new Error("\u9762\u677F\u6570\u636E\u635F\u574F");let r=e.pipeThrough(new DecompressionStream("gzip"));return _e=await new Response(r).text(),_e}function wt(t){let e=t===200?"Welcome":t===404?"Not Found":"Service Unavailable",r=`<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${e}</title><style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f7f8fa;color:#333;font-family:-apple-system,"Segoe UI","PingFang SC",sans-serif}.c{text-align:center}h1{font-size:22px;font-weight:600;margin:0 0 10px}p{color:#888;font-size:14px;margin:0}</style></head><body><div class="c"><h1>${e}</h1><p>This site is up and running.</p></div></body></html>`;return new Response(r,{status:t,headers:{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}})}function be(t,e){return new Response(JSON.stringify({ok:!1,error:t}),{status:e,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"}})}var kt=class{constructor(e){this.kv=e}kv;async get(e){return await this.kv.get(e)}async put(e,r,n){n&&n>=60?await this.kv.put(e,r,{expirationTtl:n}):await this.kv.put(e,r)}async delete(e){await this.kv.delete(e)}async list(e){let r=[],n;do{let a=await this.kv.list({prefix:e,cursor:n});for(let i of a.keys)r.push(i.name);n=a.list_complete?void 0:a.cursor}while(n);return r}},St=class{data=new Map;async get(e){let r=this.data.get(e);return r?r.expiresAt>0&&r.expiresAt<=Date.now()?(this.data.delete(e),null):r.value:null}async put(e,r,n){let a=n?Date.now()+n*1e3:0;this.data.set(e,{value:r,expiresAt:a})}async delete(e){this.data.delete(e)}async list(e){return[...this.data.keys()].filter(r=>r.startsWith(e))}};function Er(t){return t.KV?new kt(t.KV):new St}we();Ct();var Ma=15e3,Da=6e4,Q={config:null,configAt:0,auth:null,authAt:0};function It(t){return Er(t)}async function Ge(t,e){if(Q.config&&Date.now()-Q.configAt<Ma)return Q.config;let r=await sr(t,e);return Q.config=r,Q.configAt=Date.now(),r}function zr(){Q.config=null,Q.configAt=0}async function Tt(t,e){if(Q.auth&&Date.now()-Q.authAt<Da)return Q.auth;let r=await Mr(t,e.PANEL_PASSWORD,e.PANEL_PATH);return Q.auth=r,Q.authAt=Date.now(),r}function Et(t){switch((t??"").toLowerCase()){case"clash":case"mihomo":case"yaml":return"clash";case"singbox":case"sing-box":case"json":return"singbox";case"v2ray":return"v2ray";case"base64":return"base64";default:return"base64"}}function _r(t){let e=(t??"").toLowerCase();return e?e.includes("clash")||e.includes("mihomo")||e.includes("flclash")||e.includes("clashx")||e.includes("stash")?"clash":e.includes("sing-box")||e.includes("singbox")?"singbox":e.includes("v2ray")||e.includes("v2rayng")||e.includes("shadowrocket")||e.includes("nekobox")||e.includes("surge")||e.includes("loon")||e.includes("quantumult")?"base64":null:null}var Dt=null;async function Oa(){return Dt||(Dt=await Promise.resolve().then(()=>(Gr(),Wr))),Dt}function $a(t){let e=String(t??"").trim();if(!e)return e;e=e.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//,""),e=e.replace(/[/?#].*$/,"");let r=e.lastIndexOf("@");if(r>=0&&(e=e.slice(r+1)),e.startsWith("[")){let n=e.indexOf("]");n>0&&(e=e.slice(1,n))}else{let n=e.indexOf(":");n>=0&&e.indexOf(":",n+1)<0&&(e=e.slice(0,n))}return e.trim()}async function Fa(t,e,r,n){let a=await Ge(r,n),i=e.pathname.slice(5).split("/")[0]??"";if(!(i===a.uuid||i===a.trojanPassword||e.searchParams.get("token")===a.uuid))return be("\u8BA2\u9605\u4EE4\u724C\u65E0\u6548",403);let c=e.searchParams.get("target")??e.searchParams.get("format"),d=c?Et(c):_r(t.headers.get("User-Agent"))??Et(null),u=await r.get(ge)??"",l=await He(a,u),p=$a(a.subDomain||n.DATA_HOST||e.hostname),f={nodes:l.nodes,groups:l.groups,config:a,domain:p,port:443,protocol:a.subProtocol,transport:a.subTransport},h=Cr(d,f);return new Response(h.body,{status:200,headers:{"Content-Type":h.contentType,"Cache-Control":"no-store","Content-Disposition":`inline; filename="${h.fileName}"`,"Profile-Title":"CFPilot","Subscription-Userinfo":""}})}async function Zr(t,e){let r=new URL(t.url),n=It(e);if(t.method==="OPTIONS")return new Response(null,{status:204,headers:{"Access-Control-Allow-Origin":"*","Access-Control-Allow-Methods":"GET, POST, PUT, DELETE, OPTIONS","Access-Control-Allow-Headers":"Content-Type, Authorization","Access-Control-Max-Age":"86400"}});if(r.pathname==="/__edge_probe")return ze(t);if(r.pathname.startsWith("/api/")){let{handleApi:i}=await Oa(),s=await i(t,r,{store:n,env:e,config:await Ge(n,e),auth:await Tt(n,e),onConfigChanged:zr});if(s)return s}if(r.pathname==="/sub"||r.pathname.startsWith("/sub/"))return await Fa(t,r,n,e);let a=await Tt(n,e);return r.pathname===a.panelPath||r.pathname===`${a.panelPath}/`?new Response(await Tr(),{status:200,headers:{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store","X-Content-Type-Options":"nosniff","Referrer-Policy":"no-referrer"}}):null}async function jr(t){let e=It(t);return await Ge(e,t)}import{connect as Ha}from"cloudflare:sockets";var o=atob,za=new RegExp("^("+o("c29ja3M1")+"|http|https|ss):\\/\\/(.+)$","i"),yi=new RegExp(o("Y2xhc2g=")+"|"+o("c2luZ2JveA==")+"|"+o("c2luZy1ib3g=")+"|"+o("c3VyZ2U=")+"|"+o("c3VyZmJvYXJk")+"|"+o("bG9vbg==")+"|"+o("cXVhbnR1bXVsdA==")),xi=new RegExp(o("a2FyaW5n"),"i"),wi=new RegExp("(?:"+o("dmxlc3M=")+"|"+o("dHJvamFu")+"):\\/\\/[^@\\s/]+@(\\[[0-9a-fA-F:]+\\]|[A-Za-z0-9.-]+)(?::(\\d{1,5}))?"),ki=new RegExp("^"+o("dmxlc3M=")+":\\/\\/");var Yr="CFNext";var Si=o("UEFJQ05J")+"/"+o("Q0ZOZXh0");var _="application/octet-stream",je="text/yaml; charset=utf-8",Pi={Tracking:{url:"https://github.com/"+o("NjY2T1M=")+"/rules/raw/release/"+o("bWlob21v")+"/domain/Tracking.mrs",ct:_},Advertising:{url:"https://github.com/"+o("NjY2T1M=")+"/rules/raw/release/"+o("bWlob21v")+"/domain/Advertising.mrs",ct:_},AWAvenueAds:{url:"https://raw.githubusercontent.com/"+o("VEctVHdpbGlnaHQ=")+"/"+o("QVdBdmVudWU=")+"-Ads-Rule/main/Filters/"+o("QVdBdmVudWU=")+"-Ads-Rule-"+o("Q2xhc2g=")+".yaml",ct:je},Direct:{url:"https://github.com/"+o("NjY2T1M=")+"/rules/raw/release/"+o("bWlob21v")+"/domain/Direct.mrs",ct:_},Private:{url:"https://github.com/"+o("NjY2T1M=")+"/rules/raw/release/"+o("bWlob21v")+"/domain/Private.mrs",ct:_},Download:{url:"https://github.com/"+o("NjY2T1M=")+"/rules/raw/release/"+o("bWlob21v")+"/domain/Download.mrs",ct:_},AppleCN:{url:"https://github.com/"+o("NjY2T1M=")+"/rules/raw/release/"+o("bWlob21v")+"/domain/AppleCN.mrs",ct:_},China:{url:"https://cdn.jsdelivr.net/gh/"+o("YmxhY2ttYXRyaXg3")+"/"+o("aW9zX3J1bGVfc2NyaXB0")+"@master/rule/"+o("Q2xhc2g=")+"/ChinaMaxNoIP/ChinaMaxNoIP_No_Resolve.yaml",ct:je},AI:{url:"https://github.com/"+o("NjY2T1M=")+"/rules/raw/release/"+o("bWlob21v")+"/domain/AI.mrs",ct:_},Telegram:{url:"https://github.com/"+o("NjY2T1M=")+"/rules/raw/release/"+o("bWlob21v")+"/domain/Telegram.mrs",ct:_},Twitter:{url:"https://github.com/"+o("NjY2T1M=")+"/rules/raw/release/"+o("bWlob21v")+"/domain/Twitter.mrs",ct:_},SocialMedia:{url:"https://github.com/"+o("NjY2T1M=")+"/rules/raw/release/"+o("bWlob21v")+"/domain/SocialMedia.mrs",ct:_},Netflix:{url:"https://github.com/"+o("NjY2T1M=")+"/rules/raw/release/"+o("bWlob21v")+"/domain/Netflix.mrs",ct:_},[o("WW91VHViZQ==")]:{url:"https://github.com/"+o("NjY2T1M=")+"/rules/raw/release/"+o("bWlob21v")+"/domain/"+o("WW91VHViZQ==")+".mrs",ct:_},Google:{url:"https://github.com/"+o("NjY2T1M=")+"/rules/raw/release/"+o("bWlob21v")+"/domain/Google.mrs",ct:_},Microsoft:{url:"https://cdn.jsdelivr.net/gh/"+o("YmxhY2ttYXRyaXg3")+"/"+o("aW9zX3J1bGVfc2NyaXB0")+"@master/rule/"+o("Q2xhc2g=")+"/Microsoft/Microsoft.yaml",ct:je},Proxy:{url:"https://github.com/"+o("NjY2T1M=")+"/rules/raw/release/"+o("bWlob21v")+"/domain/Proxy.mrs",ct:_},Spotify:{url:"https://github.com/"+o("RHVzdGluV2lu")+"/"+o("cnVsZXNldF9nZW9kYXRh")+"/releases/download/"+o("bWlob21v")+"-ruleset/spotify.mrs",ct:_},TikTok:{url:"https://github.com/"+o("RHVzdGluV2lu")+"/"+o("cnVsZXNldF9nZW9kYXRh")+"/releases/download/"+o("bWlob21v")+"-ruleset/tiktok.mrs",ct:_},disney:{url:"https://github.com/"+o("RHVzdGluV2lu")+"/"+o("cnVsZXNldF9nZW9kYXRh")+"/releases/download/"+o("bWlob21v")+"-ruleset/disney.mrs",ct:_},github:{url:"https://rule.kelee.one/"+o("Q2xhc2g=")+"/GitHub.yaml",ct:je},PrivateIP:{url:"https://github.com/"+o("NjY2T1M=")+"/rules/raw/release/"+o("bWlob21v")+"/ip/Private.mrs",ct:_},TelegramIP:{url:"https://github.com/"+o("NjY2T1M=")+"/rules/raw/release/"+o("bWlob21v")+"/ip/Telegram.mrs",ct:_},[o("UHJveHlJUA==")]:{url:"https://github.com/"+o("NjY2T1M=")+"/rules/raw/release/"+o("bWlob21v")+"/ip/Proxy.mrs",ct:_},ChinaIP:{url:"https://github.com/"+o("NjY2T1M=")+"/rules/raw/release/"+o("bWlob21v")+"/ip/China.mrs",ct:_}};var _a=["173.245.48.0/20","103.21.244.0/22","103.22.200.0/22","103.31.4.0/22","141.101.64.0/18","108.162.192.0/18","190.93.240.0/20","188.114.96.0/20","197.234.240.0/22","198.41.128.0/17","162.158.0.0/15","104.16.0.0/13","104.24.0.0/14","172.64.0.0/13","131.0.72.0/22"];var dn=["2400:cb00::/32","2606:4700::/32","2803:f800::/32","2405:b500::/32","2405:8100::/32","2a06:98c0::/29","2c0f:f248::/32"];var Ai=dn.slice();function Wa(t){if(!pe(t=String(t||"")))return!1;if(t.indexOf(":")>=0)return dn.some(n=>(function(a,i){let[s,c]=i.split("/"),d=parseInt(c,10),u=p=>{let f=p.indexOf("::"),h;if(f>=0){let g=p.slice(0,f).split(":").filter(Boolean),y=p.slice(f+2).split(":").filter(Boolean),P=8-g.length-y.length;h=[...g,...Array(P).fill("0"),...y]}else h=p.split(":");return h.map(g=>g.padStart(4,"0"))},l=p=>p.map(f=>parseInt(f,16).toString(2).padStart(16,"0")).join("");return l(u(a)).slice(0,d)===l(u(s)).slice(0,d)})(t,n));let e=t.split(".").map(Number),r=(e[0]<<24|e[1]<<16|e[2]<<8|e[3])>>>0;return ja.some(([n,a])=>r>=n&&r<=a)}var Lt={HK:"\u9999\u6E2F",TW:"\u53F0\u6E7E",MO:"\u6FB3\u95E8",JP:"\u65E5\u672C",SG:"\u65B0\u52A0\u5761",US:"\u7F8E\u56FD",KR:"\u97E9\u56FD",DE:"\u5FB7\u56FD",FR:"\u6CD5\u56FD",GB:"\u82F1\u56FD",CA:"\u52A0\u62FF\u5927",AU:"\u6FB3\u5927\u5229\u4E9A",SE:"\u745E\u5178",NL:"\u8377\u5170",FI:"\u82AC\u5170",NO:"\u632A\u5A01",DK:"\u4E39\u9EA6",CH:"\u745E\u58EB",IT:"\u610F\u5927\u5229",ES:"\u897F\u73ED\u7259",PT:"\u8461\u8404\u7259",IE:"\u7231\u5C14\u5170",BE:"\u6BD4\u5229\u65F6",AT:"\u5965\u5730\u5229",PL:"\u6CE2\u5170",CZ:"\u6377\u514B",RO:"\u7F57\u9A6C\u5C3C\u4E9A",HU:"\u5308\u7259\u5229",GR:"\u5E0C\u814A",RU:"\u4FC4\u7F57\u65AF",TR:"\u571F\u8033\u5176",UA:"\u4E4C\u514B\u5170",IN:"\u5370\u5EA6",TH:"\u6CF0\u56FD",MY:"\u9A6C\u6765\u897F\u4E9A",VN:"\u8D8A\u5357",PH:"\u83F2\u5F8B\u5BBE",ID:"\u5370\u5C3C",BR:"\u5DF4\u897F",MX:"\u58A8\u897F\u54E5",AR:"\u963F\u6839\u5EF7",CL:"\u667A\u5229",ZA:"\u5357\u975E",EG:"\u57C3\u53CA",AE:"\u963F\u8054\u914B",IL:"\u4EE5\u8272\u5217",NZ:"\u65B0\u897F\u5170",KZ:"\u54C8\u8428\u514B\u65AF\u5766",SA:"\u6C99\u7279"},pn={};for(let t in Lt)pn[Lt[t]]=t;pn.\u5370\u5EA6\u5C3C\u897F\u4E9A="ID";var Ga={HKG:"\u9999\u6E2F",TPE:"\u53F0\u6E7E",KHH:"\u53F0\u6E7E",TSA:"\u53F0\u6E7E",RMQ:"\u53F0\u6E7E",NRT:"\u65E5\u672C",KIX:"\u65E5\u672C",HND:"\u65E5\u672C",CTS:"\u65E5\u672C",FUK:"\u65E5\u672C",SIN:"\u65B0\u52A0\u5761",ICN:"\u97E9\u56FD",KUL:"\u9A6C\u6765\u897F\u4E9A",BKK:"\u6CF0\u56FD",MNL:"\u83F2\u5F8B\u5BBE",SGN:"\u8D8A\u5357",HAN:"\u8D8A\u5357",CGK:"\u5370\u5C3C",DEL:"\u5370\u5EA6",BOM:"\u5370\u5EA6",MAA:"\u5370\u5EA6",DXB:"\u963F\u8054\u914B",TLV:"\u4EE5\u8272\u5217",RUH:"\u6C99\u7279",JED:"\u6C99\u7279",DOH:"\u5361\u5854\u5C14",FRA:"\u5FB7\u56FD",MUC:"\u5FB7\u56FD",DUS:"\u5FB7\u56FD",HAM:"\u5FB7\u56FD",BER:"\u5FB7\u56FD",CGN:"\u5FB7\u56FD",STR:"\u5FB7\u56FD",AMS:"\u8377\u5170",CDG:"\u6CD5\u56FD",MRS:"\u6CD5\u56FD",NCE:"\u6CD5\u56FD",LHR:"\u82F1\u56FD",LGW:"\u82F1\u56FD",MAN:"\u82F1\u56FD",MAD:"\u897F\u73ED\u7259",BCN:"\u897F\u73ED\u7259",MXP:"\u610F\u5927\u5229",FCO:"\u610F\u5927\u5229",PMO:"\u610F\u5927\u5229",ZRH:"\u745E\u58EB",GVA:"\u745E\u58EB",VIE:"\u5965\u5730\u5229",WAW:"\u6CE2\u5170",PRG:"\u6377\u514B",ARN:"\u745E\u5178",CPH:"\u4E39\u9EA6",OSL:"\u632A\u5A01",HEL:"\u82AC\u5170",DUB:"\u7231\u5C14\u5170",LIS:"\u8461\u8404\u7259",BRU:"\u6BD4\u5229\u65F6",BUD:"\u5308\u7259\u5229",OTP:"\u7F57\u9A6C\u5C3C\u4E9A",ATH:"\u5E0C\u814A",IST:"\u571F\u8033\u5176",SVO:"\u4FC4\u7F57\u65AF",DME:"\u4FC4\u7F57\u65AF",LED:"\u4FC4\u7F57\u65AF",JFK:"\u7F8E\u56FD",EWR:"\u7F8E\u56FD",LAX:"\u7F8E\u56FD",SJC:"\u7F8E\u56FD",SFO:"\u7F8E\u56FD",SEA:"\u7F8E\u56FD",ORD:"\u7F8E\u56FD",DFW:"\u7F8E\u56FD",IAD:"\u7F8E\u56FD",ATL:"\u7F8E\u56FD",MIA:"\u7F8E\u56FD",BOS:"\u7F8E\u56FD",DEN:"\u7F8E\u56FD",PHX:"\u7F8E\u56FD",MSP:"\u7F8E\u56FD",DTW:"\u7F8E\u56FD",PHL:"\u7F8E\u56FD",CLT:"\u7F8E\u56FD",LAS:"\u7F8E\u56FD",PDX:"\u7F8E\u56FD",SLC:"\u7F8E\u56FD",SAN:"\u7F8E\u56FD",AUS:"\u7F8E\u56FD",IAH:"\u7F8E\u56FD",MCI:"\u7F8E\u56FD",BNA:"\u7F8E\u56FD",SMF:"\u7F8E\u56FD",RDU:"\u7F8E\u56FD",YYZ:"\u52A0\u62FF\u5927",YVR:"\u52A0\u62FF\u5927",YUL:"\u52A0\u62FF\u5927",YOW:"\u52A0\u62FF\u5927",YYC:"\u52A0\u62FF\u5927",MEX:"\u58A8\u897F\u54E5",GRU:"\u5DF4\u897F",GIG:"\u5DF4\u897F",EZE:"\u963F\u6839\u5EF7",SCL:"\u667A\u5229",SYD:"\u6FB3\u5927\u5229\u4E9A",MEL:"\u6FB3\u5927\u5229\u4E9A",BNE:"\u6FB3\u5927\u5229\u4E9A",PER:"\u6FB3\u5927\u5229\u4E9A",AKL:"\u65B0\u897F\u5170",JNB:"\u5357\u975E",CAI:"\u57C3\u53CA",ALA:"\u54C8\u8428\u514B\u65AF\u5766",ALB:"\u7F8E\u56FD",BDL:"\u7F8E\u56FD",BHM:"\u7F8E\u56FD",BIL:"\u7F8E\u56FD",BOI:"\u7F8E\u56FD",BUF:"\u7F8E\u56FD",BUR:"\u7F8E\u56FD",BTV:"\u7F8E\u56FD",BWI:"\u7F8E\u56FD",CAE:"\u7F8E\u56FD",CHA:"\u7F8E\u56FD",CLE:"\u7F8E\u56FD",CMH:"\u7F8E\u56FD",CPR:"\u7F8E\u56FD",DAL:"\u7F8E\u56FD",DAY:"\u7F8E\u56FD",DSM:"\u7F8E\u56FD",DTT:"\u7F8E\u56FD",ECP:"\u7F8E\u56FD",EYW:"\u7F8E\u56FD",FLL:"\u7F8E\u56FD",GRR:"\u7F8E\u56FD",GSP:"\u7F8E\u56FD",HIO:"\u7F8E\u56FD",HNL:"\u7F8E\u56FD",ICT:"\u7F8E\u56FD",IND:"\u7F8E\u56FD",JAX:"\u7F8E\u56FD",LBB:"\u7F8E\u56FD",MCO:"\u7F8E\u56FD",MDW:"\u7F8E\u56FD",MEM:"\u7F8E\u56FD",MFE:"\u7F8E\u56FD",MFR:"\u7F8E\u56FD",MSY:"\u7F8E\u56FD",OAK:"\u7F8E\u56FD",OKC:"\u7F8E\u56FD",OMA:"\u7F8E\u56FD",ONT:"\u7F8E\u56FD",ORF:"\u7F8E\u56FD",PIT:"\u7F8E\u56FD",PSC:"\u7F8E\u56FD",PVD:"\u7F8E\u56FD",RIC:"\u7F8E\u56FD",RNO:"\u7F8E\u56FD",RSW:"\u7F8E\u56FD",SAT:"\u7F8E\u56FD",SDF:"\u7F8E\u56FD",SNA:"\u7F8E\u56FD",STL:"\u7F8E\u56FD",SWF:"\u7F8E\u56FD",SYR:"\u7F8E\u56FD",TPA:"\u7F8E\u56FD",TUL:"\u7F8E\u56FD",TUS:"\u7F8E\u56FD",CTS:"\u65E5\u672C",FUK:"\u65E5\u672C",HND:"\u65E5\u672C",BLR:"\u5370\u5EA6",CMB:"\u65AF\u91CC\u5170\u5361",KWI:"\u79D1\u5A01\u7279",AMM:"\u7EA6\u65E6",BEY:"\u9ECE\u5DF4\u5AE9",NBO:"\u80AF\u5C3C\u4E9A",LOS:"\u5C3C\u65E5\u5229\u4E9A",ACC:"\u52A0\u7EB3",CPT:"\u5357\u975E",LIM:"\u79D8\u9C81",BOG:"\u54E5\u4F26\u6BD4\u4E9A",PTY:"\u5DF4\u62FF\u9A6C"},Ci=Object.assign({},Lt,Ga,{USA:"\u7F8E\u56FD"});var Ii=["https://"+o("YmVzdGNm")+".pages.dev/random-region/HK/100.txt","https://"+o("YmVzdGNm")+".pages.dev/random-region/TW/100.txt","https://"+o("YmVzdGNm")+".pages.dev/random-region/JP/100.txt","https://"+o("YmVzdGNm")+".pages.dev/random-region/SG/100.txt","https://"+o("YmVzdGNm")+".pages.dev/random-region/US/100.txt","https://"+o("YmVzdGNm")+".pages.dev/random-region/KR/100.txt"].join(`
`);var Ti={uuid:"",path:"",admin:"",login:"",adminInit:!1,host:"",enableVless:!0,enableTrojan:!1,trojanPassword:"",enableXhttp:!1,[o("YWxwbg==")]:"",ech:!1,echHost:"cloudflare-ech.com",echDns:"",tlsOnly:!1,nodeLimit:!0,nodeLimitCount:300,countryLabel:"",loadBalance:!0,ipv6Mode:"off",cpuLimit:!1,cfAccountId:"",cfApiToken:"",quotaAuto:!1,quotaStrict:!1,tgBotToken:"",tgChatID:"",homeWan:!1,homeWanNodes:[],[o("cHJveHlJUA==")]:"",outboundProxy:"",outboundMode:"",[o("d2FycEZyb250")]:"",mode:"",warpEnable:!1,warpConf:"",warpEps:"",warpName:"",masqueEnable:!1,masqueConf:"",masqueName:"",masqueNet:"",preferredDomains:"https://"+o("YmVzdGNm")+`.pages.dev/random-region/HK/100.txt
https://`+o("YmVzdGNm")+`.pages.dev/random-region/TW/100.txt
https://`+o("YmVzdGNm")+`.pages.dev/random-region/JP/100.txt
https://`+o("YmVzdGNm")+`.pages.dev/random-region/SG/100.txt
https://`+o("YmVzdGNm")+`.pages.dev/random-region/US/100.txt
https://`+o("YmVzdGNm")+".pages.dev/random-region/KR/100.txt",preferredIPs:[],optimizer:{source:"wetest_v4",sourceURL:"",fallbackPool:"",port:443,threads:5,count:20,useCidr:!0,fillCount:0,subMode:"",subRandomCount:16,subIncludeDefault:!1},filter:{region:"all",ipType:["IPv4"],isp:["\u79FB\u52A8","\u8054\u901A","\u7535\u4FE1"]}};var Ei=[{label:"\u9999\u6E2F",region:"HK",url:"https://"+o("YmVzdGNm")+".pages.dev/random-region/HK/100.txt",count:12},{label:"\u65E5\u672C",region:"JP",url:"https://"+o("YmVzdGNm")+".pages.dev/random-region/JP/100.txt",count:12},{label:"\u7F8E\u56FD",region:"US",url:"https://"+o("YmVzdGNm")+".pages.dev/random-region/US/100.txt",count:12},{label:"\u65B0\u52A0\u5761",region:"SG",url:"https://"+o("YmVzdGNm")+".pages.dev/random-region/SG/100.txt",count:12},{label:"\u53F0\u6E7E",region:"TW",url:"https://"+o("YmVzdGNm")+".pages.dev/random-region/TW/100.txt",count:12}];var Ui=["cloudflare.182682.xyz","speed.marisalnc.com","freeyx.cloudflare88.eu.org",o("YmVzdGNm")+".top","cdn.2020111.xyz","cfip.cfcdn.vip","cf.0sm.com","cf."+o("MDkwMjI3")+".xyz","cf.zhetengsha.eu.org","cloudflare.9jy.cc","cf.zerone-cdn.pp.ua","cfip.1323123.xyz","cnamefuckxxs.yuchen.icu","cloudflare-ip.mofashi.ltd","115155.xyz","cname.xirancdn.us","f3058171cad.002404.xyz","8.889288.xyz","cdn.tzpro.xyz","cf.877771.xyz","xn--b6gac.eu.org",o("YmVzdGNm")+"."+o("MDMwMTAx")+".xyz","cdns.doon.eu.org","fn.130519.xyz","saas.sin.fan"].join(`
`);var Ri={wetest_v4:{label:"\u5FAE\u6D4B\u7F51 IPv4",url:"https://www.wetest.vip/page/cloudflare/address_v4.html"},wetest_v6:{label:"\u5FAE\u6D4B\u7F51 IPv6",url:"https://www.wetest.vip/page/cloudflare/address_v6.html"},[o("YmVzdGNm")]:{label:"\u4F18\u9009 IP \u5217\u8868",url:"https://cf."+o("MDkwMjI3")+".xyz/ip.164746.xyz"},hostmonit:{label:"HostMonit \u4F18\u9009",url:"https://stock.hostmonit.com/CloudFlareYes"},wetest_cname:{label:"\u5FAE\u6D4B\u7F51 \u4F18\u9009\u57DF\u540D",url:"https://www.wetest.vip/page/cloudflare/cname.html"}},oe=new TextEncoder,le=new TextDecoder;function de(t,e){return(t<<e|t>>>32-e)>>>0}function Ce(t,e=443){if(!(t=String(t||"").trim()))return{host:"",port:e};if(t.startsWith("[")){let n=t.match(/^\[([^\]]+)\](?::(\d+))?$/);return{host:n?n[1]:t.replace(/^\[|\]$/g,""),port:n&&n[2]?parseInt(n[2]):e}}let r=t.lastIndexOf(":");return r>0&&/^\d+$/.test(t.slice(r+1))?{host:t.slice(0,r),port:parseInt(t.slice(r+1))}:{host:t,port:e}}function pe(t){if(!(t=String(t||"").trim()))return!1;let e=t.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);if(e)return e.slice(1).every(a=>Number(a)<=255);if(!/^[0-9a-fA-F:]+$/.test(t)||(t.match(/::/g)||[]).length>1)return!1;let r=t.includes("::"),n=t.replace(/::/g,":").split(":").filter(Boolean);return!(!r&&n.length!==8)&&(!r||!(n.length<1||n.length>7))&&n.every(a=>/^[0-9a-fA-F]{1,4}$/.test(a))}function un(t){let e=[];for(let s=0;s<16;s+=2)e.push((t[s]<<8|t[s+1]).toString(16));let r=-1,n=0,a=-1,i=0;for(let s=0;s<8;s++)e[s]==="0"?(a<0?(a=s,i=1):i++,i>n&&(n=i,r=a)):(a=-1,i=0);if(n>=2){let s=e.slice(0,r).join(":");return(s?s+"::":"::")+e.slice(r+n).join(":")}return e.join(":")}function Za(t){let[e,r]=t.split("/"),n=e.split(".").map(Number),a=(n[0]<<24|n[1]<<16|n[2]<<8|n[3])>>>0,i=r>=32?0:4294967295<<32-r>>>0;return[(a&i)>>>0,(a|~i>>>0)>>>0]}var ja=_a.map(Za);function Br(t){try{let e=atob(String(t).replace(/-/g,"+").replace(/_/g,"/")),r=new Uint8Array(e.length);for(let n=0;n<e.length;n++)r[n]=e.charCodeAt(n);return new TextDecoder("utf-8").decode(r)}catch{return null}}function Ya(t){if(!t||t.byteLength<1)throw new Error(o("VkxFU1M=")+" \u5934\u90E8\u8FC7\u77ED");let e=new DataView(t.buffer,t.byteOffset,t.byteLength),r=0;if(e.getUint8(0)!==0)throw new Error("\u4E0D\u652F\u6301\u7684 "+o("VkxFU1M=")+" \u7248\u672C");if(r+=17,r>=t.byteLength)throw new Error(o("VkxFU1M=")+" \u5934\u90E8\u8FC7\u77ED");let n=e.getUint8(r);if(r+=1,r+=n,r+3>t.byteLength)throw new Error(o("VkxFU1M=")+" \u5934\u90E8\u8FC7\u77ED");let a=e.getUint8(r);r+=1;let i=e.getUint16(r);r+=2;let s=e.getUint8(r);r+=1;let{addr:c,len:d}=(function(u,l,p,f){if(f===1)return{addr:`${l.getUint8(p)}.${l.getUint8(p+1)}.${l.getUint8(p+2)}.${l.getUint8(p+3)}`,len:4};if(f===2){let h=l.getUint8(p),g=u.subarray(p+1,p+1+h);return{addr:le.decode(g),len:1+h}}if(f===3)return{addr:un(u.subarray(p,p+16)),len:16};throw new Error("\u65E0\u6CD5\u8BC6\u522B\u7684\u5730\u5740\u7C7B\u578B")})(t,e,r,s);return r+=d,{command:a,port:i,addr:c,headerLength:r,earlyData:t.subarray(r)}}var Ba=[1116352408,1899447441,3049323471,3921009573,961987163,1508970993,2453635748,2870763221,3624381080,310598401,607225278,1426881987,1925078388,2162078206,2614888103,3248222580,3835390401,4022224774,264347078,604807628,770255983,1249150122,1555081692,1996064986,2554220882,2821834349,2952996808,3210313671,3336571891,3584528711,113926993,338241895,666307205,773529912,1294757372,1396182291,1695183700,1986661051,2177026350,2456956037,2730485921,2820302411,3259730800,3345764771,3516065817,3600352804,4094571909,275423344,430227734,506948616,659060556,883997877,958139571,1322822218,1537002063,1747873779,1955562222,2024104815,2227730452,2361852424,2428436474,2756734187,3204031479,3329325298],Xr="",Jr="";function qr(t){return t!==Xr&&(Xr=t,Jr=(function(e){let r=oe.encode(String(e)),n=8*r.length,a=1+(r.length+8>>6)<<6,i=new Uint8Array(a);i.set(r),i[r.length]=128;let s=new DataView(i.buffer);s.setUint32(a-8,Math.floor(n/4294967296),!1),s.setUint32(a-4,n>>>0,!1);let c=3238371032,d=914150663,u=812702999,l=4144912697,p=4290775857,f=1750603025,h=1694076839,g=3204075428,y=(v,x)=>v>>>x|v<<32-x;for(let v=0;v<a;v+=64){let x=new Uint32Array(64);for(let S=0;S<16;S++)x[S]=s.getUint32(v+4*S,!1);for(let S=16;S<64;S++){let I=y(x[S-15],7)^y(x[S-15],18)^x[S-15]>>>3,M=y(x[S-2],17)^y(x[S-2],19)^x[S-2]>>>10;x[S]=x[S-16]+I+x[S-7]+M>>>0}let A=c,k=d,T=u,w=l,m=p,b=f,E=h,C=g;for(let S=0;S<64;S++){let I=C+(y(m,6)^y(m,11)^y(m,25))+(m&b^~m&E)+Ba[S]+x[S]>>>0,M=A&k^A&T^k&T;C=E,E=b,b=m,m=w+I>>>0,w=T,T=k,k=A,A=I+((y(A,2)^y(A,13)^y(A,22))+M>>>0)>>>0}c=c+A>>>0,d=d+k>>>0,u=u+T>>>0,l=l+w>>>0,p=p+m>>>0,f=f+b>>>0,h=h+E>>>0,g=g+C>>>0}let P="";for(let v of[c,d,u,l,p,f,h])P+=(v>>>24&255).toString(16).padStart(2,"0"),P+=(v>>>16&255).toString(16).padStart(2,"0"),P+=(v>>>8&255).toString(16).padStart(2,"0"),P+=(255&v).toString(16).padStart(2,"0");return P})(t)),Jr}var Xa=["https://doh.pub/dns-query","https://dns.alidns.com/resolve","https://1.1.1.1/dns-query","https://8.8.8.8/dns-query","https://dns.google/dns-query","https://cloudflare-dns.com/dns-query"];function Ja(t){let e=String(t).split("::"),r=e[0]?e[0].split(":").filter(Boolean):[],n=e[1]?e[1].split(":").filter(Boolean):[],a=[...r,...Array(Math.max(0,8-r.length-n.length)).fill("0"),...n],i=new Uint8Array(16);return a.forEach((s,c)=>{let d=parseInt(s,16)||0;i[2*c]=d>>8&255,i[2*c+1]=255&d}),i}async function Xe(t,e,r){let n=Ha({hostname:t,port:e});try{await(function(a,i){return Promise.race([a,new Promise((s,c)=>setTimeout(()=>c(new Error("\u8FDE\u63A5\u8D85\u65F6\uFF08SYN \u88AB\u9759\u9ED8\u4E22\u5F03\uFF09")),i||6e3))])})(n.opened,r||6e3)}catch(a){try{n.close()}catch{}throw a}return n}async function Nt(t,e){return Xe(t.hostname,t.port,e||6e3)}function Vt(t){let e=t instanceof Uint8Array?t:new Uint8Array(t),r=e.length,n=8*r,a=new Uint8Array(1+(r+8>>6)<<6);a.set(e),a[r]=128;let i=new DataView(a.buffer);i.setUint32(a.length-8,Math.floor(n/4294967296),!1),i.setUint32(a.length-4,n>>>0,!1);let s=1732584193,c=4023233417,d=2562383102,u=271733878,l=3285377520,p=new Uint32Array(80);for(let g=0;g<a.length;g+=64){for(let k=0;k<16;k++)p[k]=i.getUint32(g+4*k,!1);for(let k=16;k<80;k++)p[k]=de(p[k-3]^p[k-8]^p[k-14]^p[k-16],1);let y=s,P=c,v=d,x=u,A=l;for(let k=0;k<80;k++){let T,w;k<20?(T=P&v|~P&x,w=1518500249):k<40?(T=P^v^x,w=1859775393):k<60?(T=P&v|P&x|v&x,w=2400959708):(T=P^v^x,w=3395469782);let m=de(y,5)+T+A+w+p[k]>>>0;A=x,x=v,v=de(P,30),P=y,y=m}s=s+y>>>0,c=c+P>>>0,d=d+v>>>0,u=u+x>>>0,l=l+A>>>0}let f=new Uint8Array(20),h=new DataView(f.buffer);return h.setUint32(0,s,!1),h.setUint32(4,c,!1),h.setUint32(8,d,!1),h.setUint32(12,u,!1),h.setUint32(16,l,!1),f}function Qr(t,e){let r=t;r.length>64&&(r=Vt(r));let n=new Uint8Array(64),a=new Uint8Array(64);for(let i=0;i<64;i++)n[i]=54^(i<r.length?r[i]:0),a[i]=92^(i<r.length?r[i]:0);return Vt($(a,Vt($(n,e))))}function Kr(t,e,r){let n=Qr(e&&e.length?e:new Uint8Array(20),t),a=new Uint8Array(0),i=new Uint8Array(0);for(let s=1;i.length<r;s++){let c=new Uint8Array([s]);a=Qr(n,$($(a,oe.encode("ss-subkey")),c)),i=$(i,a)}return i.slice(0,r)}function qa(t,e,r){let n=new Uint32Array(16);n[0]=1634760805,n[1]=857760878,n[2]=2036477234,n[3]=1797285236;let a=new DataView(t.buffer,t.byteOffset,32);for(let l=0;l<8;l++)n[4+l]=a.getUint32(4*l,!0);n[12]=e>>>0;let i=new DataView(r.buffer,r.byteOffset,12);n[13]=i.getUint32(0,!0),n[14]=i.getUint32(4,!0),n[15]=i.getUint32(8,!0);let s=n.slice(),c=(l,p,f,h)=>{s[l]=s[l]+s[p]>>>0,s[h]=de(s[h]^s[l],16),s[f]=s[f]+s[h]>>>0,s[p]=de(s[p]^s[f],12),s[l]=s[l]+s[p]>>>0,s[h]=de(s[h]^s[l],8),s[f]=s[f]+s[h]>>>0,s[p]=de(s[p]^s[f],7)};for(let l=0;l<10;l++)c(0,4,8,12),c(1,5,9,13),c(2,6,10,14),c(3,7,11,15),c(0,5,10,15),c(1,6,11,12),c(2,7,8,13),c(3,4,9,14);let d=new Uint8Array(64),u=new DataView(d.buffer);for(let l=0;l<16;l++)s[l]=s[l]+n[l]>>>0,u.setUint32(4*l,s[l],!0);return d}function Ye(t,e,r,n){let a=n.slice(),i=Math.ceil(n.length/64);for(let s=0;s<i;s++){let c=qa(t,r+s,e),d=64*s,u=Math.min(64,a.length-d);for(let l=0;l<u;l++)a[d+l]^=c[l]}return a}function en(t,e){let r=0n,n=0n;for(let c=0;c<16;c++)r|=BigInt(t[c])<<BigInt(8*c),n|=BigInt(t[16+c])<<BigInt(8*c);r&=0x0ffffffc0ffffffc0ffffffc0fffffffn;let a=0n,i=(1n<<130n)-5n;for(let c=0;c<e.length;c+=16){let d=1n;for(let u=Math.min(16,e.length-c)-1;u>=0;u--)d=d<<8n|BigInt(e[c+u]);a=(a+d)*r%i}a=a+n&(1n<<128n)-1n;let s=new Uint8Array(16);for(let c=0;c<16;c++)s[c]=Number(a>>BigInt(8*c)&0xffn);return s}async function tn(t,e){let r=new Uint8Array(12),n=()=>{let i=r.slice();for(let s=11;s>=0&&(i[s]++,i[s]===0);s--);return i};if(o("Q0hBQ0hBMjA=")+"-POLY1305"===t)return{seal:i=>(function(s,c,d){let u=new Uint8Array(0),l=Ye(s,c,0,new Uint8Array(32)),p=Ye(s,c,1,d),f=y=>new Uint8Array((16-y%16)%16),h=y=>{let P=new Uint8Array(8),v=new DataView(P.buffer);return v.setUint32(0,y>>>0,!0),v.setUint32(4,Math.floor(y/4294967296),!0),P},g=$(u,$(f(u.length),$(p,$(f(p.length),$(h(u.length),h(p.length))))));return $(p,en(l,g))})(e,n(),i),open(i){let s=(function(c,d,u){if(u.length<16)throw new Error("SS AEAD \u6570\u636E\u8FC7\u77ED");let l=u.subarray(0,u.length-16),p=u.subarray(u.length-16),f=new Uint8Array(0),h=v=>new Uint8Array((16-v%16)%16),g=v=>{let x=new Uint8Array(8),A=new DataView(x.buffer);return A.setUint32(0,v>>>0,!0),A.setUint32(4,Math.floor(v/4294967296),!0),x},y=en(Ye(c,d,0,new Uint8Array(32)),$(f,$(h(f.length),$(l,$(h(l.length),$(g(f.length),g(l.length))))))),P=0;for(let v=0;v<16;v++)P|=y[v]^p[v];return P!==0?null:Ye(c,d,1,l)})(e,n(),i);if(!s)throw new Error("SS AEAD \u89E3\u5BC6\u5931\u8D25\uFF08\u5BC6\u7801/\u52A0\u5BC6\u65B9\u5F0F\u4E0E\u670D\u52A1\u5668\u4E0D\u5339\u914D\uFF09");return s}};let a=await crypto.subtle.importKey("raw",e,{name:t},!1,["encrypt","decrypt"]);return{seal:async i=>new Uint8Array(await crypto.subtle.encrypt({name:t,iv:n()},a,i)),async open(i){try{return new Uint8Array(await crypto.subtle.decrypt({name:t,iv:n()},a,i))}catch{throw new Error("SS AEAD \u89E3\u5BC6\u5931\u8D25\uFF08\u5BC6\u7801/\u52A0\u5BC6\u65B9\u5F0F\u4E0E\u670D\u52A1\u5668\u4E0D\u5339\u914D\uFF09")}}}}async function rn(t,e){let r=new Uint8Array([e.length>>8&255,255&e.length]);return $(await t.seal(r),await t.seal(e))}function $(t,e){let r=new Uint8Array(t.length+e.length);return r.set(t,0),r.set(e,t.length),r}function Qa(t,e){e:for(let r=0;r<=t.length-e.length;r++){for(let n=0;n<e.length;n++)if(t[r+n]!==e[n])continue e;return r}return-1}var q="cmliussss.net",nn={HK:o("cHJveHlpcA==")+".hk."+q,US:o("cHJveHlpcA==")+".us."+q,SG:o("cHJveHlpcA==")+".sg."+q,JP:o("cHJveHlpcA==")+".jp."+q,KR:o("cHJveHlpcA==")+".kr."+q,DE:o("cHJveHlpcA==")+".de."+q,SE:o("cHJveHlpcA==")+".se."+q,NL:o("cHJveHlpcA==")+".nl."+q,FI:o("cHJveHlpcA==")+".fi."+q,GB:o("cHJveHlpcA==")+".gb."+q,Oracle:o("cHJveHlpcA==")+".oracle."+q,DigitalOcean:o("cHJveHlpcA==")+".digitalocean."+q,Vultr:o("cHJveHlpcA==")+".vultr."+q,Multacom:o("cHJveHlpcA==")+".multacom."+q},an=(()=>{let t=Object.create(null),e=(r,n)=>{for(let a of[].concat(n))t[a]=r};return e("HK","HKG"),e("AU",["SYD","MEL","BNE","PER","ADL","CBR"]),e("SG","SIN"),e("JP",["NRT","HND","KIX","TYO","OSA","NGO","CTS","FUK","OKA"]),e("KR",["ICN","SEL","PUS"]),e("DE",["FRA","MUC","DUS","BER","HAM","STR","VIE","ZRH","CDG","MAD","MXP","FCO","PRG","WAW"]),e("SE","ARN"),e("NL","AMS"),e("FI","HEL"),e("GB",["LHR","LGW","MAN","EDI"]),e("US",["LAX","SJC","SFO","SEA","PDX","SAN","LAS","PHX","SLC","DEN","DFW","IAH","AUS","ORD","MSP","DTW","STL","MCI","ATL","MIA","MCO","BNA","CLT","IAD","BOS","EWR","JFK","PHL","YYZ","YVR","YUL","MEX","GRU"]),e("TW",["TPE","KHH","TSA","RMQ"]),t})(),on=t=>{let e=String(t||"").toUpperCase();return e?an[e]?an[e]:/^[A-Z]{2}$/.test(e)?e:"US":"US"},Be=new Map,Ka=t=>{let e=String(t||"").trim();if(!e)return[];let r=Be.get(e);if(r)return r;let n=[];for(let a of e.split(/[,;\n\r]+/)){let i=a.trim();if(!i)continue;let s="",c=/^([A-Za-z]{2})\.(.+)$/.exec(i);if(c&&pe(Ce(c[2],443).host)&&(s=c[1].toUpperCase(),i=c[2]),!s){let u=/^(.+)#([A-Za-z]{2})$/.exec(i);u&&(s=u[2].toUpperCase(),i=u[1])}let d=Ce(i,443);if(d.host){if(!s&&!pe(d.host)){for(let u of d.host.toUpperCase().split(/[^A-Z0-9]+/))if(/^[A-Z]{2}$/.test(u)&&u!=="IP"&&u!=="CF"){s=u;break}}n.push({host:d.host,port:d.port,cc:s})}}return Be.size>32&&Be.clear(),Be.set(e,n),n},sn=new Map;async function ln(t,e){if(e=e||443,pe(t))return[{hostname:t,port:e}];let r=t+":"+e,n=Date.now(),a=sn.get(r);if(a&&n-a.t<3e5)return a.ips;let i=["https://cloudflare-dns.com/dns-query","https://dns.alidns.com/resolve","https://doh.pub/dns-query"],s=async(p,f)=>{for(let h of i)try{let g=await mn(h+"?name="+encodeURIComponent(t)+"&type="+p,{headers:{accept:"application/dns-json"}},4e3);if(!g||!g.ok)continue;return((await g.json()).Answer||[]).filter(y=>y.type===f).map(y=>y.data)}catch{}return[]},c=await s("TXT",16),d=[];for(let p of c){let f=String(p).replace(/^"|"$/g,"").replace(/\\010/g,",").replace(/\n/g,",").trim();if(!f)continue;if("@"+o("ZWR0dW5uZWw=")===f)break;let h=f.split(/[,;\s]+/).map(y=>y.trim()).filter(Boolean),g=[];for(let y of h){let{host:P,port:v}=Ce(y,e);pe(P)&&g.push({hostname:P,port:v})}if(g.length){d=g;break}}d.length||(d=(await s("A",1)).filter(p=>/^\d+\.\d+\.\d+\.\d+$/.test(p)).map(p=>({hostname:p,port:e}))),d.length||(d=(await s("AAAA",28)).filter(p=>pe(p)).map(p=>({hostname:p,port:e})));let u=new Set,l=d.filter(p=>{let f=p.hostname+":"+p.port;return!u.has(f)&&(u.add(f),!0)});return l.length&&sn.set(r,{t:n,ips:l}),l}async function Ot(t){if(!t||!t.length)return null;let e=!1;return await new Promise(r=>{let n=t.length,a=i=>{if(n--,i)if(e)try{i.close()}catch{}else e=!0,r(i);else n<=0&&!e&&r(null)};for(let i of t)Promise.resolve().then(i).then(s=>a(s&&s.readable?s:null),()=>a(null))})}async function cn(t,e,r){let n=null,a=p=>{if(p&&p!==n)try{p.close()}catch{}},i=t?Promise.resolve().then(t).then(p=>p&&p.readable?p:null,()=>null):Promise.resolve(null),s=e&&e.length?Ot(e).then(p=>p&&p.readable?p:null,()=>null):Promise.resolve(null),c=null,d=await Promise.race([i,new Promise(p=>{c=setTimeout(()=>p("__GRACE__"),r)})]);if(c&&(clearTimeout(c),c=null),d&&d!=="__GRACE__")return n=d,s.then(a),n;let u=await s;if(u)return n=u,i.then(a),n;let l=await i;return l?(n=l,n):null}function eo(t){return!t||t.byteLength<3?"unknown":t[0]===22&&t[1]===3?"tls":"nontls"}async function to(t,e,r,n,a){let i=(function(m){if(!m)return null;let b=o("c29ja3M1"),E=String(m).trim(),C=E.match(za);if(C&&(b=C[1].toLowerCase(),E=C[2]),b==="ss")return(function(L){let V=L,U="",R=L.indexOf("#");R>=0&&(V=L.slice(0,R));let N=V.lastIndexOf("@");if(N>=0)U=V.slice(0,N),V=V.slice(N+1);else{let G=Br(V);if(G&&G.includes("@")){let j=G.lastIndexOf("@");U=G.slice(0,j),V=G.slice(j+1)}}let H="",B="";if(U){let G=Br(U)||U;try{G=decodeURIComponent(G)}catch{}let j=G.indexOf(":");j>0?(H=G.slice(0,j),B=G.slice(j+1)):H=G}let{host:ie,port:W}=Ce(V,8388);return{type:"ss",host:ie,port:W,method:H,password:B}})(E);let S="",I="";if(E.includes("@")){let[L,V]=E.split("@"),U=N=>{try{return decodeURIComponent(N)}catch{return N}},R=L.indexOf(":");R>=0?(S=U(L.slice(0,R)),I=U(L.slice(R+1))):S=U(L),E=V}let M=b==="http"?80:b==="https"?443:1080,{host:D,port:F}=Ce(E,M);return{type:b,host:D,port:F,user:S,pass:I}})(e.outboundProxy),s=e.outboundMode||"",c=a!=="nontls",d=i?i.type==="http"||i.type==="https"?m=>(async function(b,E){let C=await Xe(b.host,b.port,6e3),S=C.writable.getWriter(),I=C.readable.getReader(),M="";b.user&&(M=o("UHJveHktQXV0aG9yaXphdGlvbg==")+": Basic "+(function(V){let U="";for(let R=0;R<V.length;R+=32768)U+=String.fromCharCode(...V.subarray(R,R+32768));return btoa(U)})(oe.encode(`${b.user}:${b.pass}`))+`\r
`);let D=`${o("Q09OTkVDVA==")} ${E.hostname}:${E.port} HTTP/1.1\r
Host: ${E.hostname}:${E.port}\r
${M}\r
`;await S.write(oe.encode(D));let{head:F,leftover:L}=await(async function(V){let U=new Uint8Array(0);for(;U.length<65536;){let{done:R,value:N}=await V.read();if(R)break;U=$(U,N);let H=Qa(U,[13,10,13,10]);if(H>=0)return{head:le.decode(U.subarray(0,H)),leftover:U.subarray(H+4)}}return{head:le.decode(U),leftover:new Uint8Array(0)}})(I);if(!/^HTTP\/\d\.\d\s+2\d\d/i.test(F))throw new Error(o("Q09OTkVDVA==")+" \u5931\u8D25: "+F.split(`\r
`)[0]);return L&&L.byteLength>0&&(C._preamble=L),S.releaseLock(),I.releaseLock(),C})(i,m):i.type==="ss"?m=>(async function(b){let E=(function(U){let R=String(U||"").toLowerCase().replace(/_/g,"-");return o("YWVzLTEyOC1nY20=")===R||R==="aes-128gcm"?{name:"AES-GCM",keyLen:16}:o("YWVzLTI1Ni1nY20=")===R||R==="aes-256gcm"?{name:"AES-GCM",keyLen:32}:o("Y2hhY2hhMjA=")+"-ietf-poly1305"===R||o("Y2hhY2hhMjA=")+"-poly1305"===R||o("Y2hhY2hhMjA=")+"poly1305"===R?{name:o("Q0hBQ0hBMjA=")+"-POLY1305",keyLen:32}:null})(b.method);if(!E)throw new Error("\u4E0D\u652F\u6301\u7684 SS \u52A0\u5BC6\u65B9\u5F0F: "+(b.method||"\uFF08\u672A\u6307\u5B9A\uFF09"));if(!b.password)throw new Error("SS \u51FA\u7AD9\u7F3A\u5C11\u5BC6\u7801");let C=await Xe(b.host,b.port,6e3),S=C.writable.getWriter(),I=C.readable.getReader(),M=new Uint8Array(0),D=async U=>{for(;M.length<U;){let{done:N,value:H}=await I.read();if(N)throw new Error("SS \u8FDE\u63A5\u88AB\u5173\u95ED");M=$(M,H)}let R=M.slice(0,U);return M=M.subarray(U),R},F=new Uint8Array(await crypto.subtle.digest("SHA-256",oe.encode(b.password))),L=crypto.getRandomValues(new Uint8Array(16)),V=await tn(E.name,await Kr(F,L,E.keyLen));return await S.write(L),await S.write(await rn(V,new Uint8Array(0))),{readable:new ReadableStream({async start(U){try{let R=await D(16),N=await tn(E.name,await Kr(F,R,E.keyLen));for(;;){let H=await N.open(await D(18)),B=H[0]<<8|H[1];if(B>16384)throw new Error("SS \u5206\u7247\u957F\u5EA6\u975E\u6CD5 "+B);let ie=await N.open(await D(B+16));B>0&&U.enqueue(ie)}}catch(R){try{U.error(R)}catch{}}}}),writable:new WritableStream({async write(U){let R=U instanceof Uint8Array?U:new Uint8Array(U);for(let N=0;N<R.length;N+=16384)await S.write(await rn(V,R.subarray(N,Math.min(R.length,N+16384))))},close(){try{S.close()}catch{}},abort(){try{S.abort()}catch{}}}),close(){try{C.close()}catch{}}}})(i):m=>(async function(b,E){let C=await Xe(b.host,b.port,6e3),S=C.writable.getWriter(),I=C.readable.getReader(),M=new Uint8Array(0),D=async N=>{for(;M.length<N;){let{done:B,value:ie}=await I.read();if(B)throw new Error("\u8FDE\u63A5\u88AB\u5173\u95ED");M=$(M,ie)}let H=M.slice(0,N);return M=M.subarray(N),H},F=b.user?[5,2,0,2]:[5,1,0];await S.write(new Uint8Array(F));let L=await D(2);if(L[0]!==5||L[1]===255)throw new Error(o("U09DS1M1")+" \u63E1\u624B\u5931\u8D25");if(L[1]===2){if(!b.user)throw new Error(o("U09DS1M1")+" \u670D\u52A1\u5668\u8981\u6C42\u8BA4\u8BC1\u4F46\u672A\u63D0\u4F9B\u51ED\u636E");let N=oe.encode(b.user),H=oe.encode(b.pass),B=new Uint8Array([1,N.length,...N,H.length,...H]);if(await S.write(B),(await D(2))[1]!==0)throw new Error(o("U09DS1M1")+" \u8BA4\u8BC1\u5931\u8D25")}else if(L[1]!==0)throw new Error(o("U09DS1M1")+" \u4E0D\u652F\u6301\u7684\u8BA4\u8BC1\u65B9\u6CD5 "+L[1]);let V=oe.encode(E.hostname),U;U=/^\d+\.\d+\.\d+\.\d+$/.test(E.hostname)?new Uint8Array([5,1,0,1,...E.hostname.split(".").map(Number),E.port>>8&255,255&E.port]):new Uint8Array([5,1,0,3,V.length,...V,E.port>>8&255,255&E.port]),await S.write(U);let R=await D(4);if(R[1]!==0)throw new Error(o("U09DS1M1")+" \u8FDE\u63A5\u5931\u8D25 \u7801"+R[1]);if(R[3]===1)await D(6);else if(R[3]===3){let N=(await D(1))[0];await D(N+2)}else R[3]===4&&await D(18);return M.byteLength>0&&(C._preamble=M),S.releaseLock(),I.releaseLock(),C})(i,m):null,u,l=async m=>{try{let b=await m();if(b)return b}catch(b){u=b}return null},p=()=>{throw u||new Error("\u6240\u6709\u51FA\u7AD9\u65B9\u5F0F\u5747\u5931\u8D25")},f=e.proxyIP?Ka(e.proxyIP):[],h=on(r),g=String(r||"").toUpperCase(),y=[];if(f.length&&c){for(let m of f)m.cc&&(m.cc===h||m.cc===g)&&y.push(m);for(let m of f)m.cc||y.push(m);y.length||y.push(f[0]);for(let m of y.slice(0,3)){let b=await l(async()=>{let E=[];try{E=await ln(m.host,m.port)}catch{}E.length||(E=[{hostname:m.host,port:m.port}]);let C=await Ot(E.slice(0,4).map(S=>()=>l(()=>Nt(S,4e3))));if(C)return C});if(b)return b}}let P={hostname:t.addr,port:t.port},v=()=>{if(!c)return[];let m=on(r);return[m,...Object.keys(nn).filter(E=>E!==m)].slice(0,2).map((E,C)=>async()=>{let S=nn[E];if(!S)return null;let I=[];try{I=await ln(S,443)}catch{return null}if(!I.length)return null;let M=I.slice(0,C===0?2:1);return await Ot(M.map(D=>()=>l(()=>Nt(D,4e3))))})},x=()=>l(()=>Nt(P,4e3)),A=d?()=>l(()=>d(P)):null,k=Wa(t.addr)?0:300,T=()=>cn(x,v().slice(0,3),k);if(s==="only"&&A){let m=await A();return m||await cn(null,v().slice(0,4),0)||p()}if(s===""&&A){let m=await A();return m||await T()||p()}let w=await T();if(w)return w;if(A){let m=await A();if(m)return m}return p()}async function fn(t,e){let r=new WebSocketPair,[n,a]=Object.values(r);try{a.accept({allowHalfOpen:!0})}catch{a.accept()}a.binaryType="arraybuffer";let i=null,s=null,c=!1,d=null,u=null,l=!1,p=y=>{try{a.send(y)}catch{}},f=async(y,P)=>{if(y&&y.byteLength&&(d=d?$(d,y):y),!d)return;if(d.byteLength>65536)throw new Error("\u63E1\u624B\u5934\u8D85\u8FC7 64KB\uFF0C\u5173\u95ED\u8FDE\u63A5");let v,x;try{let T=(function(w,m){if(!m.enableTrojan||!w||w.byteLength<58)return!1;let b=w.subarray(0,56);if(le.decode(b).toLowerCase()===qr(m.trojanPassword||m.uuid))return!0;if(w[56]===13&&w[57]===10){for(let E=0;E<56;E++){let C=b[E];if(!(C>=48&&C<=57||C>=97&&C<=102||C>=65&&C<=70))return!1}return!0}return!1})(d,e);if(!T&&d.byteLength>0&&d[0]!==0&&d.byteLength<58)return;x=!T,v=T?(function(w){if(!w||w.byteLength<66)throw new Error(o("VHJvamFu")+" \u5934\u90E8\u8FC7\u77ED");let m=new DataView(w.buffer,w.byteOffset,w.byteLength),b=58,E=m.getUint8(b);b+=1;let C=m.getUint8(b),S,I;if(b+=1,C===1)S=`${m.getUint8(b)}.${m.getUint8(b+1)}.${m.getUint8(b+2)}.${m.getUint8(b+3)}`,I=4;else if(C===3){let D=m.getUint8(b);S=le.decode(w.subarray(b+1,b+1+D)),I=1+D}else{if(C!==4)throw new Error("\u65E0\u6CD5\u8BC6\u522B\u7684\u5730\u5740\u7C7B\u578B");S=un(w.subarray(b,b+16)),I=16}b+=I;let M=m.getUint16(b);return b+=2,b+=2,{command:E,port:M,addr:S,password:le.decode(w.subarray(0,56)),headerLength:b}})(d):Ya(d)}catch(T){if(/头部过短/.test(T.message||""))return;throw T}!l&&x&&v.command!==2&&(l=!0,p(new Uint8Array([0,0])));let A=eo(d.byteLength>v.headerLength?d.subarray(v.headerLength):null);if(A==="unknown"&&!P)return void(u||(u=setTimeout(()=>{u=null,f(new Uint8Array(0),!0).catch(T=>{try{a.close(1011,String(T&&T.message||T))}catch{}})},80)));if(u&&(clearTimeout(u),u=null),c)return;if(c=!0,v.command===2){try{let T=d.subarray(v.headerLength);if(v.port===53&&T.byteLength>=12){let w=await(async function(m){if(!m||m.byteLength<17)return null;let b=new DataView(m.buffer,m.byteOffset,m.byteLength),E=b.getUint16(0);if(32768&b.getUint16(2)||b.getUint16(4)!==1)return null;let C=12,S=[];for(;C<m.byteLength;){let W=b.getUint8(C);if(W===0){C++;break}if(!(192&~W)){C+=2;break}if(C+1+W>m.byteLength)return null;S.push(le.decode(m.subarray(C+1,C+1+W))),C+=1+W}if(C+4>m.byteLength||S.length===0)return null;let I=b.getUint16(C),M=b.getUint16(C+2),D=C+4;if(I!==1&&I!==28)return null;let F=S.join("."),L=m.subarray(12,D),V=null;for(let W of Xa)try{let G=await mn(W+"?name="+encodeURIComponent(F)+"&type="+I,{headers:{accept:"application/dns-json"}},5e3);if(!G||!G.ok)continue;let j=await G.json();if(!j||j.Status!==0)continue;let fe=(j.Answer||[]).filter(ae=>ae.type===I&&(ae.type===1?pe(String(ae.data)):/^[0-9a-fA-F:]+$/.test(String(ae.data))));if(fe.length){V=fe;break}}catch{}if(!V)return null;let U=new Uint8Array(12),R=new DataView(U.buffer);R.setUint16(0,E),R.setUint16(2,33152),R.setUint16(4,1),R.setUint16(6,V.length);let N=[U,L];for(let W of V){let G=String(W.data),j=W.type===1?Uint8Array.from(G.split(".").map(Number)):Ja(G);if(j.length!==(W.type===1?4:16))continue;let fe=new Uint8Array(10),ae=new DataView(fe.buffer);ae.setUint16(0,49164),ae.setUint16(2,W.type),ae.setUint16(4,M===0?1:M),ae.setUint32(6,Number(W.TTL)||300),N.push(fe,new Uint8Array([j.length>>8&255,255&j.length]),j)}let H=0;N.forEach(W=>H+=W.byteLength);let B=new Uint8Array(H),ie=0;for(let W of N)B.set(W,ie),ie+=W.byteLength;return B})(T);w&&p(w)}}catch{}try{a.close(1e3)}catch{}return}let k=await to(v,e,t.cf&&t.cf.colo,0,A);i=k,s=k.writable.getWriter(),k._preamble&&k._preamble.byteLength>0&&p(k._preamble),d&&d.byteLength>v.headerLength&&await s.write(d.subarray(v.headerLength)),d=null,(async function(T,w,m){try{for(;;){let{done:b,value:E}=await T.read();if(b)break;w(E)}}catch{}try{m&&m()}catch{}})(k.readable.getReader(),p,()=>{try{a.close(1e3)}catch{}})},h=(function(y,P){if(!y)return null;let v=String(y).trim();if(!v||v.length>8192||!/^[A-Za-z0-9\-_+/=]+$/.test(v))return null;let x=null;try{let A=v.replace(/-/g,"+").replace(/_/g,"/"),k=A.length%4?"=".repeat(4-A.length%4):"",T=atob(A+k);x=new Uint8Array(T.length);for(let w=0;w<T.length;w++)x[w]=T.charCodeAt(w)}catch{return null}if(!x.byteLength||x.byteLength>6144)return null;if(x.byteLength>=17&&x[0]===0){let A=(function(k){let T=String(k||"").replace(/-/g,"");if(T.length!==32)return null;let w=new Uint8Array(16);for(let m=0;m<16;m++){let b=parseInt(T.substr(2*m,2),16);if(isNaN(b))return null;w[m]=b}return w})(P.uuid);if(!A)return x;for(let k=0;k<16;k++)if(x[k+1]!==A[k])return null;return x}return P.enableTrojan&&x.byteLength>=58&&x[56]===13&&x[57]===10&&le.decode(x.subarray(0,56)).toLowerCase()===qr(P.trojanPassword||P.uuid)?x:null})(t.headers.get("sec-websocket-protocol"),e);h&&f(h).catch(y=>{try{a.close(1011,String(y&&y.message||y))}catch{}}),a.addEventListener("message",async y=>{try{let P=typeof y.data=="string"?oe.encode(y.data):new Uint8Array(y.data);c?s?await s.write(P):d=d?$(d,P):P:await f(P)}catch(P){try{a.close(1011,String(P&&P.message||P))}catch{}}});let g=()=>{if(u&&(clearTimeout(u),u=null),i){try{i.close()}catch{}i=null}};return a.addEventListener("close",g),a.addEventListener("error",g),new Response(null,{status:101,webSocket:n})}function mn(t,e,r){return new Promise(n=>{let a=new AbortController,i=setTimeout(()=>a.abort(),r);fetch(t,Object.assign({},e,{signal:a.signal})).then(s=>{clearTimeout(i),n(s)}).catch(()=>{clearTimeout(i),n(null)})})}var Mi="https://api."+o("Y2xvdWRmbGFyZWNsaWVudA==")+".com/v0a5641/reg",Di="https://api."+o("Y2xvdWRmbGFyZWNsaWVudA==")+".com/v0a2158/reg",Ni=o("d3d3Lm1pY3Jvc29mdC5jb20=");var Vi=String.raw`
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
*{box-sizing:border-box;margin:0;padding:0}:root{--bg:#06080d;--bg2:#090d14;--card:#0c1119;--card2:#101724;--border:#1a2331;--text:#e9eef7;--dim:#93a3b8;--faint:#61718a;--line:#131a25;--accent:#7c6cff;--accent2:#22d3ee;--accent-dim:rgba(124,108,255,.14);--ok:#22c55e;--ok-dim:rgba(34,197,94,.13);--err:#f87171;--err-dim:rgba(248,113,113,.13);--warn:#fbbf24;--sb-bg:#080c12;--sb-text:#9fb0c5;--sb-dim:#5f7292;--sb-border:#161d28;--sb-active-bg:rgba(124,108,255,.14);--sb-active-text:#ab9dff;--sb-active-bar:#7c6cff;--glass:rgba(23,32,45,.54);--glass-2:rgba(19,27,39,.62);--glass-line:rgba(255,255,255,.10);--sb-glass:rgba(20,28,41,.50);--sb-rim:rgba(255,255,255,.46);--sb-vol-a:rgba(255,255,255,.11);--sb-vol-b:rgba(0,0,0,.20);--sb-glass-m:rgba(15,21,32,.88);--glass-rim:rgba(255,255,255,.30);--glass-hi:rgba(255,255,255,.12);--glass-field:rgba(255,255,255,.045);--glass-hover:rgba(255,255,255,.07);--glass-btn:rgba(255,255,255,.09);--glass-btn-hi:rgba(255,255,255,.17);--glass-rim-sm:rgba(255,255,255,.55);--glass-field-brd:rgba(255,255,255,.09);--glass-blur:22px;--glass-sh:0 20px 48px rgba(0,0,0,.42);--glass-shx:12px 0 36px rgba(0,0,0,.30);--blob-o:.44;--shadow:0 14px 40px rgba(0,0,0,.4);color-scheme:dark}[data-theme="light"]{--bg:#f4f6fb;--bg2:#eaeef6;--card:#fff;--card2:#f7f9fd;--border:#e1e7f0;--text:#16202e;--dim:#5a6a80;--faint:#93a1b4;--line:#eaeff6;--accent:#6355f5;--accent2:#0ea5b7;--accent-dim:rgba(99,85,245,.10);--ok:#17915a;--ok-dim:rgba(23,145,90,.11);--err:#dc4c4c;--err-dim:rgba(220,76,76,.10);--warn:#b7791f;--sb-bg:#ffffff;--sb-text:#5a6a80;--sb-dim:#9aa8bb;--sb-border:#e5eaf2;--sb-active-bg:rgba(99,85,245,.10);--sb-active-text:#5546e8;--sb-active-bar:#6355f5;--glass:rgba(255,255,255,.50);--glass-2:rgba(255,255,255,.60);--glass-line:rgba(20,40,70,.10);--sb-glass:rgba(255,255,255,.46);--sb-rim:rgba(255,255,255,1);--sb-vol-a:rgba(255,255,255,.68);--sb-vol-b:rgba(20,40,70,.075);--sb-glass-m:rgba(255,255,255,.90);--glass-rim:rgba(255,255,255,.95);--glass-hi:rgba(255,255,255,.70);--glass-field:rgba(255,255,255,.62);--glass-hover:rgba(20,40,70,.055);--glass-btn:rgba(255,255,255,.86);--glass-btn-hi:#ffffff;--glass-rim-sm:rgba(255,255,255,1);--glass-field-brd:rgba(20,40,70,.11);--glass-blur:22px;--glass-sh:0 18px 44px rgba(25,45,80,.13);--glass-shx:10px 0 30px rgba(25,45,80,.09);--blob-o:.42;--shadow:0 12px 34px rgba(25,40,70,.12);color-scheme:light}html,body{min-height:100%}body{background:var(--bg);color:var(--text);font-family:"PingFang SC","Microsoft YaHei","Segoe UI",system-ui,sans-serif;font-size:14px;line-height:1.6;-webkit-font-smoothing:antialiased}a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}.app{display:flex;min-height:100vh;gap:12px;padding:12px}.sidebar{width:232px;flex:0 0 232px;background:var(--sb-bg);border-right:1px solid var(--sb-border);display:flex;flex-direction:column;position:sticky;top:12px;height:calc(100vh - 24px);z-index:50}.brand{display:flex;align-items:center;gap:11px;padding:18px 18px 14px}.brand .lg{width:34px;height:34px;flex:0 0 34px;border-radius:10px;background:linear-gradient(135deg,var(--accent),var(--accent2));display:flex;align-items:center;justify-content:center;box-shadow:0 4px 12px var(--accent-dim)}.brand .lg svg{width:18px;height:18px;stroke:#0b0e14;fill:none;stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round}.brand .bt{display:flex;flex-direction:column;line-height:1.25;min-width:0}.brand .bt b{font-size:15px;font-weight:700;letter-spacing:.3px}.brand .bt span{font-size:11px;color:var(--sb-dim);white-space:nowrap;over${o("Zmxvdzo=")}hidden;text-over${o("Zmxvdzo=")}ellipsis}.nav{flex:1;padding:6px 10px 12px;overflow-y:auto}.nav-item{display:flex;align-items:center;gap:10px;width:100%;padding:9px 12px;margin:2px 0;border:none;background:transparent;color:var(--sb-text);font-size:13.5px;font-family:inherit;text-align:left;cursor:pointer;border-radius:8px;position:relative;transition:.15s}.nav-item svg{width:17px;height:17px;flex:0 0 17px;stroke:currentColor;fill:none;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}.nav-item:hover{background:var(--sb-active-bg);color:var(--sb-active-text)}.nav-item.on{background:var(--sb-active-bg);color:var(--sb-active-text);font-weight:600}.nav-item.on::before{content:"";position:absolute;left:-10px;top:8px;bottom:8px;width:3px;border-radius:0 3px 3px 0;background:var(--sb-active-bar)}.side-foot{padding:12px 18px;border-top:1px solid var(--sb-border);display:flex;align-items:center;justify-content:space-between;font-size:11.5px;color:var(--sb-dim)}.ver-chip{font-family:ui-monospace,Consolas,monospace;background:var(--accent-dim);color:var(--sb-active-text);padding:2px 8px;border-radius:6px;font-size:11px;border:1px solid transparent}.main{flex:1;min-width:0;display:flex;flex-direction:column;gap:12px}.topbar{display:flex;align-items:center;gap:14px;padding:12px 20px;border:1px solid var(--border);border-radius:18px;background:var(--bg);position:sticky;top:12px;z-index:40}.topbar h1{font-size:17px;font-weight:600;flex:1;min-width:0}.ibtn.hamb{display:none}.pill{display:inline-flex;align-items:center;gap:6px;font-size:12px;padding:4px 11px;border-radius:20px;background:var(--ok-dim);color:var(--ok);white-space:nowrap}.pill.off{background:var(--err-dim);color:var(--err)}.pill i{width:6px;height:6px;border-radius:50%;background:currentColor;display:block}.ibtn{width:34px;height:34px;border-radius:9px;border:1px solid var(--border);background:var(--card2);color:var(--dim);cursor:pointer;display:flex;align-items:center;justify-content:center}.ibtn:hover{border-color:var(--accent);color:var(--accent)}.ibtn svg{width:16px;height:16px;stroke:currentColor;fill:none;stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round}.wrap{width:100%;max-width:1180px;margin:0 auto;padding:0 4px 96px}.view{display:none}.view.on{display:block;animation:up .2s ease}@keyframes up{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}.vh{margin-bottom:16px}.vh h2{font-size:20px;font-weight:700}.vh p{color:var(--dim);font-size:13px;margin-top:3px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(330px,1fr));gap:16px}.grid3{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:16px}.card{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:18px;margin-bottom:16px}.card h3{font-size:14px;font-weight:650;margin-bottom:14px;display:flex;align-items:center;gap:9px}.card h3 .dot{width:4px;height:15px;border-radius:3px;background:linear-gradient(var(--accent),var(--accent2))}.card h3 .sub{font-size:12px;color:var(--dim);font-weight:400;margin-left:auto}.kv{display:flex;justify-content:space-between;gap:12px;padding:8px 0;border-bottom:1px dashed var(--line);font-size:13px}.kv:last-child{border-bottom:none}.kv .k{color:var(--dim);white-space:nowrap}.kv .v{text-align:right;word-break:break-all;font-family:ui-monospace,Consolas,monospace;font-size:12.5px}.kv .v.ok{color:var(--ok)}.kv .v.bad{color:var(--err)}.kv .v.warn{color:var(--warn)}.field{margin-bottom:13px}.field>label{display:block;font-size:12.5px;color:var(--dim);margin-bottom:6px;font-weight:500}input[type=text],input[type=password],input[type=number],select,textarea{width:100%;background:var(--card2);border:1px solid var(--border);color:var(--text);border-radius:9px;padding:9px 11px;font-size:13.5px;outline:none;font-family:inherit;transition:.15s}input:focus,select:focus,textarea:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-dim)}textarea{resize:vertical;line-height:1.55;font-family:ui-monospace,Consolas,monospace;font-size:12.5px}select{cursor:pointer;appearance:none;-webkit-appearance:none;padding-right:30px;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%2393a3b8' stroke-width='1.6' fill='none' stroke-linecap='round'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 11px center}select option,select optgroup{background:var(--bg2);color:var(--text)}input,select,textarea{accent-color:var(--accent)}.hint{font-size:12px;color:var(--dim);margin-top:7px;line-height:1.7}.inrow{display:flex;gap:8px;align-items:flex-start}.inrow>div{flex:1}.sw{position:relative;display:inline-block;width:40px;height:22px;flex:0 0 40px}.sw input{opacity:0;width:0;height:0}.sw .sl{position:absolute;inset:0;background:var(--border);border-radius:22px;cursor:pointer;transition:.18s}.sw .sl::before{content:"";position:absolute;width:16px;height:16px;left:3px;top:3px;background:#fff;border-radius:50%;transition:transform .18s}.sw input:checked+.sl{background:var(--accent)}.sw input:checked+.sl::before{transform:translateX(18px)}.prow{display:flex;align-items:center;gap:11px;padding:9px 0;border-bottom:1px dashed var(--line);font-size:13.5px}.prow:last-child{border-bottom:none}.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;border:1px solid var(--border);background:var(--card2);color:var(--text);border-radius:9px;padding:9px 15px;font-size:13px;cursor:pointer;font-family:inherit;white-space:nowrap;transition:.15s}.btn:hover{border-color:var(--accent);color:var(--accent)}.btn:active{transform:translateY(1px)}.btn:disabled{opacity:.5;cursor:not-allowed}.btn.pri{background:linear-gradient(135deg,var(--accent),var(--accent2));border-color:transparent;color:#0b0e14;font-weight:600}.btn.pri:hover{filter:brightness(1.07);color:#0b0e14}.btn.dgr{background:var(--err-dim);border-color:transparent;color:var(--err)}.btn.sm{padding:5px 11px;font-size:12px;border-radius:7px}.row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.row .grow{flex:1;min-width:150px}.pills{display:flex;flex-wrap:wrap;gap:8px}.sp{position:relative}.sp input{position:absolute;opacity:0;pointer-events:none}.sp span{display:inline-block;padding:5px 13px;border:1px solid var(--border);border-radius:999px;font-size:12.5px;color:var(--dim);cursor:pointer;background:var(--card2);transition:.15s;user-select:none}.sp:hover span{border-color:var(--accent);color:var(--accent)}.sp input:checked+span{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:600}.blk{border-top:1px solid var(--line);margin-top:14px;padding-top:14px}.blk-t{font-size:12px;font-weight:600;color:var(--dim);margin-bottom:10px;letter-spacing:.4px}.tbl{overflow-x:auto}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:9px 10px;font-size:13px;border-bottom:1px solid var(--line);white-space:nowrap}th{color:var(--dim);font-weight:500;font-size:12px;background:var(--card2)}td.ip{font-family:ui-monospace,Consolas,monospace;font-size:12.5px}.bdg{display:inline-block;padding:2px 9px;border-radius:10px;font-size:11.5px}.bdg.g{background:var(--ok-dim);color:var(--ok)}.bdg.r{background:var(--err-dim);color:var(--err)}.mono{font-family:ui-monospace,Consolas,monospace;font-size:12.5px}.msg{display:none;margin-top:12px;padding:10px 13px;border-radius:9px;font-size:12.5px;line-height:1.65}.msg.on{display:block}.msg.ok{background:var(--ok-dim);color:var(--ok)}.msg.err{background:var(--err-dim);color:var(--err)}.msg.info{background:var(--accent-dim);color:var(--accent)}pre.code{background:var(--bg2);border:1px solid var(--border);border-radius:9px;padding:12px;font-size:11.5px;line-height:1.55;font-family:ui-monospace,Consolas,monospace;over${o("Zmxvdzo=")}auto;max-height:280px;white-space:pre-wrap;word-break:break-all;color:var(--dim);margin-top:10px}.bar{position:fixed;right:20px;bottom:20px;display:flex;gap:10px;align-items:center;z-index:60}.bar .btn{box-shadow:var(--shadow)}.stat{font-size:11.5px;color:var(--faint);background:var(--card);border:1px solid var(--border);border-radius:9px;padding:6px 11px;box-shadow:var(--shadow);white-space:nowrap}.toast{position:fixed;left:50%;bottom:26px;transform:translateX(-50%) translateY(90px);background:var(--card);border:1px solid var(--border);padding:11px 20px;border-radius:11px;font-size:13px;opacity:0;transition:.25s;z-index:200;box-shadow:var(--shadow);pointer-events:none;max-width:86vw}.toast.on{opacity:1;transform:translateX(-50%) translateY(0)}.toast.ok{border-color:var(--ok);color:var(--ok)}.toast.err{border-color:var(--err);color:var(--err)}.toast.warn{border-color:var(--warn);color:var(--warn)}.note{background:var(--card2);border:1px solid var(--border);border-left:3px solid var(--accent);border-radius:9px;padding:12px 14px;font-size:12.5px;color:var(--dim);line-height:1.75}.steps{list-style:none;counter-reset:st}.steps li{counter-increment:st;position:relative;padding:0 0 15px 32px;font-size:13px;color:var(--dim)}.steps li::before{content:counter(st);position:absolute;left:0;top:1px;width:22px;height:22px;border-radius:50%;background:var(--accent-dim);color:var(--accent);display:flex;align-items:center;justify-content:center;font-size:11.5px;font-weight:700}.steps li b{color:var(--text)}.prog{height:9px;border-radius:7px;background:var(--card2);over${o("Zmxvdzo=")}hidden;margin:10px 0}.prog>div{height:100%;width:0;border-radius:7px;background:linear-gradient(90deg,var(--ok),var(--accent));transition:width .5s}.qr{display:flex;justify-content:center;padding:12px 0 2px}.qr img{width:170px;height:170px;image-rendering:pixelated;border-radius:10px;background:#fff;padding:8px}.dz{border:1px solid var(--err);border-radius:14px;padding:16px;background:var(--err-dim);margin-bottom:16px}.dz h3{font-size:14px;color:var(--err);margin-bottom:8px}.fgrp{border:1px solid var(--border);border-radius:11px;padding:12px;margin-bottom:12px}.fgrp-t{font-size:12px;font-weight:600;color:var(--dim);margin-bottom:9px}.bgfx{position:fixed;inset:0;z-index:0;over${o("Zmxvdzo=")}hidden;pointer-events:none}.bgfx i{position:absolute;display:block;border-radius:50%;filter:blur(74px);opacity:var(--blob-o);will-change:transform}.bgfx i:nth-child(1){width:46vw;height:46vw;left:-12vw;top:-16vh;background:var(--accent);animation:blob 24s ease-in-out infinite}.bgfx i:nth-child(2){width:38vw;height:38vw;right:-14vw;top:2vh;background:var(--accent2);opacity:calc(var(--blob-o) * .72);animation:blob 30s ease-in-out infinite -8s}.bgfx i:nth-child(3){width:34vw;height:34vw;left:20vw;bottom:-22vh;background:#f472b6;opacity:calc(var(--blob-o) * .55);animation:blob 27s ease-in-out infinite -14s}.bgfx i:nth-child(4){width:30vw;height:30vw;right:10vw;bottom:-16vh;background:#38bdf8;opacity:calc(var(--blob-o) * .5);animation:blob 33s ease-in-out infinite -20s}@keyframes blob{0%,100%{transform:translate3d(0,0,0) scale(1)}33%{transform:translate3d(4vw,4vh,0) scale(1.1)}66%{transform:translate3d(-3vw,2vh,0) scale(.94)}}.app{position:relative;z-index:1}.sidebar{background:var(--sb-glass);-webkit-backdrop-filter:blur(30px) saturate(190%);backdrop-filter:blur(30px) saturate(190%);border:1px solid var(--glass-line);border-radius:22px;corner-shape:squircle;isolation:isolate;box-shadow:var(--glass-sh),inset 0 1px 0 var(--glass-hi),0 0 0 1px rgba(255,255,255,.03)}.sidebar::before{content:"";position:absolute;inset:0;border-radius:inherit;pointer-events:none;z-index:0;background:radial-gradient(520px 400px at var(--mx,50%) var(--my,-16%),var(--glass-hi),transparent 62%),linear-gradient(180deg,var(--sb-vol-a) 0,rgba(0,0,0,0) 32%,rgba(0,0,0,0) 60%,var(--sb-vol-b) 100%)}.sidebar::after{content:"";position:absolute;inset:0;border-radius:inherit;padding:1px;pointer-events:none;z-index:1;background:linear-gradient(150deg,var(--sb-rim) 0,rgba(255,255,255,0) 34%,rgba(255,255,255,0) 66%,var(--sb-rim) 100%);-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);mask-composite:exclude}.sidebar>*{position:relative;z-index:2}.side-foot{border-top:1px solid var(--glass-line)}.nav::-webkit-scrollbar{width:8px}.nav::-webkit-scrollbar-thumb{background:var(--glass-field-brd);border-radius:8px}.nav-item{border-radius:12px}.nav-item:hover{background:var(--glass-hover)}.nav-item.on{background:var(--sb-active-bg);box-shadow:inset 0 1px 0 var(--glass-hi),0 6px 18px rgba(0,0,0,.16)}.topbar{background:var(--glass-2);-webkit-backdrop-filter:blur(20px) saturate(180%);backdrop-filter:blur(20px) saturate(180%);border:1px solid var(--glass-line);box-shadow:var(--glass-sh),inset 0 1px 0 var(--glass-hi)}.topbar::after{content:"";position:absolute;inset:0;border-radius:inherit;padding:1px;pointer-events:none;background:linear-gradient(150deg,var(--glass-rim) 0,rgba(255,255,255,0) 36%,rgba(255,255,255,0) 64%,var(--glass-rim) 100%);-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);mask-composite:exclude}.ibtn{position:relative;background:var(--glass-field);border:1px solid var(--glass-field-brd);border-radius:11px;box-shadow:inset 0 1px 0 var(--glass-hi);transition:.18s cubic-bezier(.34,1.4,.64,1)}.ibtn:hover{background:var(--glass);border-color:var(--glass-rim);color:var(--accent);transform:translateY(-1px)}.ibtn:active{transform:translateY(0) scale(.96)}.card{position:relative;background:var(--glass);-webkit-backdrop-filter:blur(var(--glass-blur)) saturate(170%);backdrop-filter:blur(var(--glass-blur)) saturate(170%);border:1px solid var(--glass-line);border-radius:20px;corner-shape:squircle;box-shadow:var(--glass-sh),inset 0 1px 0 var(--glass-hi)}.card>*{position:relative;z-index:1}.card::before{content:"";position:absolute;inset:0;border-radius:inherit;pointer-events:none;z-index:0;background:radial-gradient(440px 260px at var(--mx,50%) var(--my,-12%),var(--glass-hi),transparent 68%)}.card::after{content:"";position:absolute;inset:0;border-radius:inherit;padding:1px;pointer-events:none;z-index:0;background:linear-gradient(150deg,var(--glass-rim) 0,rgba(255,255,255,0) 32%,rgba(255,255,255,0) 64%,var(--glass-rim) 100%);-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);mask-composite:exclude}.fgrp{background:var(--glass-field);border:1px solid var(--glass-field-brd);border-radius:14px;corner-shape:squircle}.note{background:var(--glass-field);border:1px solid var(--glass-field-brd);border-left:3px solid var(--accent);border-radius:14px}pre.code{background:var(--glass-field);border:1px solid var(--glass-field-brd);border-radius:14px}.msg{border-radius:13px}input[type=text],input[type=password],input[type=number],select,textarea{background:var(--glass-field);border:1px solid var(--glass-field-brd);border-radius:12px;box-shadow:inset 0 1px 0 var(--glass-hi)}.sp span{background:var(--glass-field);border:1px solid var(--glass-field-brd)}th{background:var(--glass-field)}.btn{background:var(--glass-field);border:1px solid var(--glass-field-brd);border-radius:13px;position:relative;box-shadow:inset 0 1px 0 var(--glass-hi),0 4px 14px rgba(0,0,0,.16);transition:.18s cubic-bezier(.34,1.4,.64,1)}.btn:hover{background:var(--glass);border-color:var(--glass-rim);color:var(--text);transform:translateY(-1px)}.btn:active{transform:translateY(0) scale(.985)}.btn.sm{border-radius:10px}.btn.pri{background:linear-gradient(135deg,var(--accent),var(--accent2));border-color:transparent;color:#0b0e14;box-shadow:0 8px 24px var(--accent-dim),inset 0 1px 0 rgba(255,255,255,.45);over${o("Zmxvdzo=")}hidden}.btn.pri:hover{color:#0b0e14;filter:brightness(1.06)}.btn.pri::after{content:"";position:absolute;top:-60%;left:-40%;width:36%;height:220%;pointer-events:none;transform:rotate(16deg);background:linear-gradient(90deg,rgba(255,255,255,0),rgba(255,255,255,.6),rgba(255,255,255,0));opacity:0;transition:opacity .2s}.btn.pri:hover::after{opacity:1;animation:sheen .85s cubic-bezier(.4,0,.2,1)}@keyframes sheen{from{left:-40%}to{left:130%}}.bar .stat{background:var(--glass);-webkit-backdrop-filter:blur(18px) saturate(180%);backdrop-filter:blur(18px) saturate(180%);border:1px solid var(--glass-line);border-radius:14px;box-shadow:var(--glass-sh)}.toast{background:var(--glass);-webkit-backdrop-filter:blur(24px) saturate(180%);backdrop-filter:blur(24px) saturate(180%);border:1px solid var(--glass-line);border-radius:16px;box-shadow:var(--glass-sh)}.pill{box-shadow:inset 0 1px 0 rgba(255,255,255,.18)}.btn::before,.ibtn::before,.sp span::before,.pill::before,.nav-item.on::after{content:"";position:absolute;inset:0;border-radius:inherit;padding:1px;pointer-events:none;background:linear-gradient(160deg,var(--glass-rim-sm) 0,rgba(255,255,255,0) 42%,rgba(255,255,255,0) 58%,var(--glass-rim-sm) 100%);-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);mask-composite:exclude}.btn{background:var(--glass-btn);border-radius:13px;box-shadow:inset 0 1px 0 var(--glass-hi),0 6px 18px rgba(0,0,0,.20),0 1px 2px rgba(0,0,0,.18)}.btn:hover{background:var(--glass-btn-hi);border-color:var(--glass-rim-sm);color:var(--text);transform:translateY(-1px);box-shadow:inset 0 1px 0 var(--glass-hi),0 10px 26px rgba(0,0,0,.26)}.bar .btn{box-shadow:inset 0 1px 0 var(--glass-hi),var(--glass-sh)}.ibtn{background:var(--glass-btn);box-shadow:inset 0 1px 0 var(--glass-hi),0 4px 12px rgba(0,0,0,.16)}.ibtn:hover{background:var(--glass-btn-hi)}.sp span{position:relative;background:var(--glass-btn);box-shadow:inset 0 1px 0 var(--glass-hi)}.sp input:checked+span{box-shadow:inset 0 1px 0 rgba(255,255,255,.35),0 4px 14px var(--accent-dim)}.pill{position:relative;box-shadow:inset 0 1px 0 rgba(255,255,255,.22)}.ver-chip{position:relative;box-shadow:inset 0 1px 0 rgba(255,255,255,.20)}.nav-item{border-radius:12px}.nav-item.on{background:linear-gradient(180deg,rgba(255,255,255,.10),rgba(255,255,255,0)),var(--sb-active-bg);box-shadow:inset 0 1px 0 var(--glass-hi),0 8px 20px rgba(0,0,0,.18)}.sw .sl{background:var(--glass-field);border:1px solid var(--glass-field-brd);box-shadow:inset 0 1px 2px rgba(0,0,0,.16)}.sw input:checked+.sl{background:linear-gradient(135deg,var(--accent),var(--accent2));border-color:transparent;box-shadow:inset 0 1px 0 rgba(255,255,255,.40),0 2px 10px var(--accent-dim)}.sw .sl::before{box-shadow:0 1px 4px rgba(0,0,0,.40)}.bdg{box-shadow:inset 0 1px 0 rgba(255,255,255,.20)}.fgrp,.note,pre.code{box-shadow:inset 0 1px 0 var(--glass-hi)}.msg{box-shadow:inset 0 1px 0 rgba(255,255,255,.14)}.prog{background:var(--glass-field);border:1px solid var(--glass-field-brd);box-shadow:inset 0 1px 2px rgba(0,0,0,.14)}.steps li::before{background:var(--accent-dim);box-shadow:inset 0 1px 0 rgba(255,255,255,.22)}.dz{background:var(--err-dim);border:1px solid rgba(248,113,113,.30);border-radius:18px;-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);box-shadow:var(--glass-sh)}@supports not ((backdrop-filter:blur(1px)) or (-webkit-backdrop-filter:blur(1px))){.sidebar,.topbar{background:var(--card2)}.card{background:var(--card)}.btn,.ibtn,.sp span{background:var(--card2)}.bar .stat,.toast{background:var(--card)}}@media(prefers-reduced-motion:reduce){.bgfx i{animation:none}.btn.pri:hover::after{animation:none;opacity:0}.ibtn:hover,.btn:hover{transform:none}.view.on{animation:none}}@media(max-width:640px){:root{--glass-blur:14px}.sidebar{-webkit-backdrop-filter:blur(18px) saturate(180%);backdrop-filter:blur(18px) saturate(180%)}.bgfx i:nth-child(3),.bgfx i:nth-child(4){display:none}}@media(max-width:960px){.sidebar{position:fixed;left:12px;top:12px;height:calc(100vh - 24px);background:var(--sb-glass-m);transform:translateX(calc(-100% - 28px));transition:transform .22s ease;z-index:70;box-shadow:var(--glass-sh),inset 0 1px 0 var(--glass-hi)}.sidebar.open{transform:translateX(0)}.ibtn.hamb{display:flex}.app{padding:10px;gap:10px}.wrap{padding:0 2px 92px}.topbar{padding:10px 14px;top:10px}}@media(max-width:560px){.topbar .pill{display:none}}[data-style="material"]{--bg:var(--m-surface);--bg2:var(--m-surface-container);--card:var(--m-surface-container-low);--card2:var(--m-surface-container);--border:var(--m-outline-variant);--line:var(--m-outline-variant);--text:var(--m-on-surface);--dim:var(--m-on-surface-variant);--faint:var(--m-outline);--accent:var(--m-primary);--accent2:var(--m-tertiary);--accent-dim:var(--m-primary-container);--ok:var(--m-primary);--ok-dim:var(--m-primary-container);--err:var(--m-error);--err-dim:var(--m-error-container);--warn:var(--m-tertiary);--glass-rim:transparent;--glass-rim-sm:transparent;--glass-hi:transparent;--sb-rim:transparent;--sb-vol-a:transparent;--sb-vol-b:transparent;--m-e1:0 1px 2px rgba(0,0,0,.42),0 1px 3px 1px rgba(0,0,0,.24);--m-e2:0 1px 2px rgba(0,0,0,.42),0 2px 6px 2px rgba(0,0,0,.24);--m-e3:0 1px 3px rgba(0,0,0,.42),0 4px 8px 3px rgba(0,0,0,.24);--shadow:var(--m-e2);font-family:Roboto,"Roboto Flex","Noto Sans SC","PingFang SC","Microsoft YaHei",system-ui,sans-serif}[data-theme="light"][data-style="material"]{--m-e1:0 1px 2px rgba(0,0,0,.16),0 1px 3px 1px rgba(0,0,0,.09);--m-e2:0 1px 2px rgba(0,0,0,.16),0 2px 6px 2px rgba(0,0,0,.09);--m-e3:0 1px 3px rgba(0,0,0,.16),0 4px 8px 3px rgba(0,0,0,.09)}[data-style="material"] .bgfx{display:none}[data-style="material"] .card::before,[data-style="material"] .card::after,[data-style="material"] .sidebar::before,[data-style="material"] .sidebar::after,[data-style="material"] .topbar::after{display:none}[data-style="material"] .sidebar{background:var(--m-surface-container-low);-webkit-backdrop-filter:none;backdrop-filter:none;border:none;border-radius:16px;box-shadow:var(--m-e1)}[data-style="material"] .brand .lg{border-radius:12px;box-shadow:none}[data-style="material"] .brand .bt b{font-weight:500}[data-style="material"] .nav-item{border-radius:28px;padding:10px 16px;font-size:14px}[data-style="material"] .nav-item.on::before{display:none}[data-style="material"] .nav-item.on{background:var(--m-secondary-container);color:var(--m-on-secondary-container);font-weight:500;box-shadow:none}[data-style="material"] .nav-item:hover{background:transparent;color:var(--text)}[data-style="material"] .side-foot{border-top:1px solid var(--m-outline-variant)}[data-style="material"] .ver-chip{background:var(--m-secondary-container);color:var(--m-on-secondary-container);border-radius:8px;box-shadow:none}[data-style="material"] .topbar{background:var(--m-surface);-webkit-backdrop-filter:none;backdrop-filter:none;border:none;border-radius:16px;box-shadow:none}[data-style="material"] .topbar h1{font-weight:400;font-size:20px}[data-style="material"] .ibtn{background:transparent;border:none;border-radius:50%;color:var(--m-on-surface-variant);box-shadow:none;over${o("Zmxvdzo=")}hidden}[data-style="material"] .ibtn:hover{background:transparent;color:var(--m-on-surface)}[data-style="material"] .ibtn:active{transform:none}[data-style="material"] .pill{background:var(--m-secondary-container);color:var(--m-on-secondary-container);border-radius:8px;box-shadow:none;padding:5px 12px;font-weight:500}[data-style="material"] .card{background:var(--m-surface-container-low);border:none;border-radius:16px;box-shadow:var(--m-e1);-webkit-backdrop-filter:none;backdrop-filter:none}[data-style="material"] .card h3{font-weight:500}[data-style="material"] .card h3 .dot{background:var(--m-primary)}[data-style="material"] .fgrp,[data-style="material"] .note,[data-style="material"] pre.code{background:var(--m-surface-container);border:1px solid var(--m-outline-variant);border-radius:12px;box-shadow:none}[data-style="material"] .note{border-left:1px solid var(--m-outline-variant)}[data-style="material"] .msg{border-radius:12px;box-shadow:none}[data-style="material"] input[type=text],[data-style="material"] input[type=password],[data-style="material"] input[type=number],[data-style="material"] select,[data-style="material"] textarea{background:transparent;border:1px solid var(--m-outline);border-radius:8px;box-shadow:none}[data-style="material"] input:focus,[data-style="material"] select:focus,[data-style="material"] textarea:focus{border-color:var(--m-primary);box-shadow:inset 0 0 0 1px var(--m-primary)}[data-style="material"] th{background:var(--m-surface-container);font-weight:500}[data-style="material"] .bdg{box-shadow:none;background:var(--m-secondary-container);color:var(--m-on-secondary-container)}[data-style="material"] .box{background:var(--m-surface-container-high);border:none;border-radius:28px;-webkit-backdrop-filter:none;backdrop-filter:none;box-shadow:var(--m-e3);corner-shape:round}[data-style="material"] .box::after{display:none}[data-style="material"] .logo{background:var(--m-primary-container);border-radius:16px;box-shadow:none}[data-style="material"] .logo svg{stroke:var(--m-on-primary-container)}[data-style="material"] .box p{color:var(--m-on-surface-variant)}[data-style="material"] .btn{background:var(--m-secondary-container);color:var(--m-on-secondary-container);border:none;border-radius:20px;box-shadow:none;font-weight:500;-webkit-mask:none;over${o("Zmxvdzo=")}hidden}[data-style="material"] .btn:hover{background:var(--m-secondary-container);color:var(--m-on-secondary-container);transform:none;box-shadow:var(--m-e1)}[data-style="material"] .btn:active{transform:none}[data-style="material"] .btn.pri{background:var(--m-primary);color:var(--m-on-primary);box-shadow:none;border-radius:20px}[data-style="material"] .btn.pri:hover{background:var(--m-primary);color:var(--m-on-primary);box-shadow:var(--m-e1);filter:none}[data-style="material"] .btn.pri::after{display:none}[data-style="material"] .btn.sm{border-radius:18px}[data-style="material"] .btn.dgr{background:var(--m-error);color:var(--m-on-error)}[data-style="material"] .sp span{background:transparent;border:1px solid var(--m-outline);color:var(--m-on-surface-variant);border-radius:20px;box-shadow:none}[data-style="material"] .sp input:checked+span{background:var(--m-secondary-container);color:var(--m-on-secondary-container);border-color:transparent;box-shadow:none}[data-style="material"] .btn::before,[data-style="material"] .ibtn::before,[data-style="material"] .sp span::before,[data-style="material"] .nav-item::before{content:"";position:absolute;inset:0;border-radius:inherit;background:currentColor;opacity:0;-webkit-mask:none;mask:none;pointer-events:none;transition:opacity .12s}[data-style="material"] .btn:hover::before,[data-style="material"] .ibtn:hover::before,[data-style="material"] .sp span:hover::before,[data-style="material"] .nav-item:hover::before{opacity:.08}[data-style="material"] .btn:active::before,[data-style="material"] .ibtn:active::before,[data-style="material"] .sp span:active::before{opacity:.12}[data-style="material"] .card,.md-rip-host{position:relative}[data-style="material"] .nav-item,[data-style="material"] .sp span,[data-style="material"] .pill,[data-style="material"] .fgrp{position:relative;over${o("Zmxvdzo=")}hidden}.md-rip{position:absolute;border-radius:50%;pointer-events:none;background:currentColor;opacity:0;transform:scale(0);animation:mdRip .62s cubic-bezier(.2,0,0,1) forwards}@keyframes mdRip{0%{opacity:.20;transform:scale(.25)}55%{opacity:.14}100%{opacity:0;transform:scale(1)}}@media(prefers-reduced-motion:reduce){.md-rip{display:none}}[data-style="material"] .sw .sl{background:var(--m-surface-container-highest);border:1px solid var(--m-outline);box-shadow:none}[data-style="material"] .sw input:checked+.sl{background:var(--m-primary);border-color:var(--m-primary);box-shadow:none}[data-style="material"] .sw .sl::before{box-shadow:0 1px 3px rgba(0,0,0,.30)}[data-style="material"] .prog{background:var(--m-surface-container-highest);border:none;border-radius:4px;box-shadow:none;height:8px}[data-style="material"] .prog>div{border-radius:4px;background:var(--m-primary)}[data-style="material"] .steps li::before{background:var(--m-primary-container);color:var(--m-on-primary-container);box-shadow:none}[data-style="material"] .dz{background:var(--m-error-container);border:none;border-radius:16px;-webkit-backdrop-filter:none;backdrop-filter:none;box-shadow:none}[data-style="material"] .dz h3{color:var(--m-on-error-container)}[data-style="material"] .dz p{color:var(--m-on-error-container)}[data-style="material"] .bar .stat,[data-style="material"] .toast{background:var(--m-surface-container-high);-webkit-backdrop-filter:none;backdrop-filter:none;border:none;border-radius:12px;box-shadow:var(--m-e3);color:var(--text)}[data-style="material"] .bar .btn{box-shadow:var(--m-e2)}[data-style="material"] .qr img{border-radius:12px}.seg{display:flex;gap:8px;flex-wrap:wrap}.seg button{flex:1;min-width:120px;justify-content:center}.seg button.on{background:var(--accent);color:#fff;border-color:transparent}[data-style="material"] .seg button.on{background:var(--m-primary);color:var(--m-on-primary)}.md-sw{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}.md-sw i{width:30px;height:30px;border-radius:50%;cursor:pointer;display:block;box-shadow:0 0 0 1px var(--border);transition:transform .15s}.md-sw i:hover{transform:scale(1.1)}.md-sw i.on{box-shadow:0 0 0 2px var(--accent),0 0 0 4px var(--bg2)}.md-pal{margin-top:14px;border:1px solid var(--border);border-radius:12px;over${o("Zmxvdzo=")}hidden}.md-pal .r{display:flex;align-items:center;gap:2px;padding:3px 6px}.md-pal .r b{width:66px;flex:0 0 66px;font-size:10.5px;font-weight:500;color:var(--dim);font-family:ui-monospace,Consolas,monospace}.md-pal .r i{flex:1;height:20px;border-radius:4px;display:block;cursor:pointer;position:relative;z-index:0;transition:transform .12s ease,box-shadow .12s ease}.md-pal .r:hover b{color:var(--text)}.md-pal .r i:hover{transform:scale(1.16);z-index:3;box-shadow:0 0 0 1.5px var(--text),0 4px 10px rgba(0,0,0,.45)}.md-pal .r i.on{z-index:2;box-shadow:inset 0 0 0 2px rgba(255,255,255,.94),inset 0 0 0 4px rgba(0,0,0,.56)}.md-pal .r:first-child i{border-radius:6px 6px 4px 4px}.md-pal .r:last-child i{border-radius:4px 4px 6px 6px}.md-out{display:flex;align-items:center;gap:9px;margin-top:10px;flex-wrap:wrap;font-size:12px}.md-out .chip{width:20px;height:20px;border-radius:6px;flex:0 0 20px;display:block;box-shadow:0 0 0 1px var(--border)}.md-out .hx{font-family:ui-monospace,Consolas,monospace;color:var(--text);cursor:pointer;letter-spacing:.4px;padding:3px 7px;border-radius:7px;background:var(--bg2);box-shadow:0 0 0 1px var(--border)}.md-out .hx:hover{background:var(--card2)}.md-out .tag{color:var(--faint)}.md-seed{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}.md-seed i{width:34px;height:34px;border-radius:9px;cursor:pointer;display:block;box-shadow:0 0 0 1px var(--border);transition:transform .15s}.md-seed i:hover{transform:scale(1.08)}.md-seed i.on{box-shadow:0 0 0 2px var(--accent),0 0 0 4px var(--bg2)}

/* ===== ${o("Q0ZOZXh0")} 自有组件层：对齐参考面板视觉 ===== */
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
/* 开关滑块本体：${o("Q0ZOZXh0")} 的 DOM 是 label.switch>span.sl（无 .sw 祖先），nimbus 的 .sw .sl 不匹配，须单独补回 */
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
    <div class="bt"><b>${Yr}</b><span>Cloudflare 隧道面板</span></div>
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
              <option value="${o("Y2xhc2g=")}">${o("Q2xhc2g=")} / ${o("TWlob21v")}</option>
              <option value="${o("c2luZ2JveA==")}">${o("U2luZy1ib3g=")}</option>
              <option value="${o("a2FyaW5n")}">${o("S2FyaW5n")}</option>
              <option value="${o("c3VyZ2U=")}">${o("U3VyZ2U=")}</option>
              <option value="${o("c3VyZmJvYXJk")}">${o("U3VyZmJvYXJk")}</option>
              <option value="${o("bG9vbg==")}">${o("TG9vbg==")}</option>
              <option value="${o("cXVhbng=")}">${o("UXVhbnR1bXVsdA==")} X</option>
              <option value="${o("djJyYXk=")}">${o("djJyYXlO")} / ${o("U2hhZG93cm9ja2V0")}</option>
              <option value="${o("c3Rhc2g=")}">${o("U3Rhc2g=")}</option>
              <option value="plain">明文 ${o("dmxlc3M=")}</option>
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
          <div style="margin:10px 0 6px;height:8px;border-radius:6px;background:var(--card2);over${o("Zmxvdzo=")}hidden">
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
          <div class="proto-row"><label class="switch"><input type="checkbox" id="en-${o("dmxlc3M=")}" checked><span class="sl"></span></label><span>${o("VkxFU1M=")} 协议（默认开启）</span></div>
          <div class="proto-row"><label class="switch"><input type="checkbox" id="en-${o("dHJvamFu")}"><span class="sl"></span></label><span>${o("VHJvamFu")} 协议（支持${o("TWlob21v")}内核）</span></div>
          <div class="proto-row"><label class="switch"><input type="checkbox" id="en-${o("eGh0dHA=")}"><span class="sl"></span></label><span>${o("WEhUVFA=")} 协议（支持${o("TWlob21v")}内核，须绑定域名开启${o("Z1JQQw==")}）</span></div>
          <div class="field" style="margin-top:12px"><label>${o("VHJvamFu")} 密码（留空使用 UUID）</label><input type="text" id="tp-pass" placeholder="${o("VHJvamFu")} 密码" autocomplete="off"></div>
        </div>
        <div class="card">
          <h3><span class="tick"></span>TLS 与传输</h3>
          <div class="proto-row"><label class="switch"><input type="checkbox" id="tls-only"><span class="sl"></span></label><span>仅 TLS 端口（跳过 80/8080 等明文端口）</span></div>
          <div class="field" style="margin-top:12px"><label>${o("QUxQTg==")} 协商（h2 / http/1.1，逗号分隔）</label><input type="text" id="${o("YWxwbg==")}" placeholder="留空自动，如 h2,http/1.1" autocomplete="off"></div>
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
        <p class="hint">开启后订阅节点附带 ech 参数与 ${o("YWxwbg==")} 协商，客户端需支持 ECH 才生效。</p>
      </div>
      <div class="card">
        <h3><span class="tick"></span>落地与出站</h3>
        <div class="field"><label>反代 / 落地（可填多个，英文逗号分隔；支持域名与 IP，可带两位国家代码；留空则直连失败后走内置地区出口）</label><input type="text" id="s-${o("cHJveHlJUA==")}" placeholder="如：Proxy-HK.a.com,HK.43.132.231.159:443,8.219.155.125:443#JP" autocomplete="off"></div>
        <p class="hint">多条时按节点落地国家自动匹配。带国家代码的条目只用于该国节点，两种写法等价：域名把国家代码放在名字里（如 Proxy-HK.… 里的 HK），IP 写成前缀式 HK.1.2.3.4:443 或后缀式 1.2.3.4:443#HK（IPv6 用方括号，如 HK.[2001:db8::1]:443）。不带国家代码的条目（含纯 IP）作为通用候选，按填写顺序依次尝试。某国无对应条目时退回列表首条；只填一条时行为与旧版一致。</p>
        <div class="field"><label>出站（可选）</label><input type="text" id="s-${o("b3V0Ym91bmQ=")}" placeholder="${o("c29ja3M1")}://user:pass@1.2.3.4:1080 或 ${o("c3M6Ly9jaGFjaGEyMA==")}-ietf-poly1305:密码@1.2.3.4:8388" autocomplete="off"></div>
        <p class="hint">支持 ${o("c29ja3M1")}://（可带 user:pass@）、http(s)://、${o("c3M6Ly8=")} 或 host:port（默认按 ${o("c29ja3M1")}，端口 1080）。SS 加密支持 ${o("YWVzLTEyOC1nY20=")} / ${o("YWVzLTI1Ni1nY20=")} / ${o("Y2hhY2hhMjA=")}-ietf-poly1305。</p>
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
              <option value="${o("YmVzdGNm")}">优选 IP 列表（${o("YmVzdGNm")}）</option>
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
        <div class="field" style="margin-top:8px"><label>兜底优选池 URL <span style="font-weight:400;color:var(--faint)">（可选，换行/分号分隔，上限 10 个；URL 查询串中的逗号原样保留；留空用内置 ${o("YmVzdGNm")} 地区池）</span></label><input type="text" id="o-fbpool" placeholder="https://a.example/ips.txt;https://b.example/ips.txt" autocomplete="off"></div>
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
          <textarea id="f-preferred" rows="6" placeholder="*.cloudflare.182682.xyz&#10;104.25.246.53:443#香港&#10;https://${o("YmVzdGNm")}.pages.dev/random-region/HK/100.txt"></textarea>
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
          <div style="margin:10px 0 6px;height:10px;border-radius:6px;background:var(--card2);over${o("Zmxvdzo=")}hidden">
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
      <div class="view-head"><h2>WARP 配置</h2><p>下发 WARP（${o("V2lyZUd1YXJk")}）节点由客户端直连：本服务只做配置解析与格式转换，不承载流量。${o("V2lyZUd1YXJk")} 走 UDP 2408，部分运营商屏蔽 UDP 时表现为全部超时</p></div>
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
            <textarea id="w-front" rows="2" placeholder="${o("dmxlc3M=")}://… / trojan://… / ${o("c3M6")}//… / ${o("c29ja3M1")}://…（WARP 节点经它拨号，可绕过运营商对 UDP 的封锁）"></textarea>
          </div>
          <div class="hint">仅 <code>clash</code> 格式生效；留空则 WARP 节点直连。<b>前置必须能承载 UDP</b>，解析失败会自动忽略。</div>
          <div class="inrow"><button class="btn sm" onclick="regenWarp()">重新生成凭据</button></div>
          <div class="hint">部署后无需任何填写：首次拉取订阅时本服务会自动完成注册并写入你的存储，之后一直复用。凭据只保存在你自己的存储中，不外发。若换客户端后连不上，可点上方按钮重签一次。</div>
        </div>
      </div>
    </section>

    <!-- ===== 视图：家宽模式 ===== -->
    <section class="view" data-view="${o("aG9tZQ==")}">
      <div class="view-head"><h2>家宽模式</h2><p>VPN Gate OpenVPN 家宽出口，经隧道前置拨号（仅 ${o("TWlob21v")} 内核）</p></div>
      <div class="card" style="border-color:var(--accent)">
        <h3><span class="tick"></span>家宽出口</h3>
        <div class="proto-row"><label class="switch"><input type="checkbox" id="hw-on"><span class="sl"></span></label><span>VPN Gate OpenVPN （仅${o("TWlob21v")}内核）</span></div>
        <p class="hint">- 该开关由运行模式自动控制：选「家宽模式」自动打开，切到其它模式自动关闭。<br>- 每日拉取，取最快 100 台，仅留 TCP 家宽节点（「家宽 + 地区」、同区编号；UDP 剔除）。<br>- 缓存 30 分钟；&lt;30 台强制刷新，失败用旧缓存。<br>- 家宽须经隧道前置拨号；隧道节点 Worker 自动生成、自动测活、不受筛选。<br>- 开启后订阅仅含家宽 + 隧道节点；默认节点不下发（自定义订阅除外）。</p>
      </div>
      <div class="card">
        <h3><span class="tick"></span>VPN Gate 手写参数</h3>
        <div class="field"><label>每行一条：主机 端口 协议 地区（空格或冒号分隔，留空则自动拉取）</label>
          <textarea id="hw-cfg" rows="7" placeholder="116.12.3.63 1357 tcp JP&#10;219.100.37.10 1194 udp KR&#10;1.2.3.4:443:tcp:US"></textarea></div>
        <p class="hint" style="margin-top:8px">- 手写参数<b>优先级高于自动拉取</b>：填了就不再访问 VPN Gate 列表，订阅里出现的就是你手写的这几台。<br>- 两种写法：① 直接粘贴 VPN Gate 的 base64 配置（可加地区码前缀，如 JP: 开头）；② 主机 端口 协议 地区，同时在本框内用 ca: / cert: / key: 给出证书。<br>- 内核要求 openvpn 必须带内联证书，<b>缺少证书的行会被忽略</b>（可先点「试用并预览」看解析结果）。<br>- 端口省略默认 1194；协议省略默认 tcp（只认 tcp / udp）；地区省略默认 XX，节点名形如「家宽JP」。<br>- 认证沿用 VPN Gate 公共账号 vpn / vpn；仅 ${o("TWlob21v")} 内核支持 openvpn 出站。</p>
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

    <!-- ===== 视图：${o("TUFTUVVF")} 模式 ===== -->
    <section class="view" data-view="${o("bWFzcXVl")}">
      <div class="view-head"><h2>${o("TUFTUVVF")} 配置</h2><p>下发 ${o("TUFTUVVF")} 节点由客户端直连：需 ${o("TWlob21v")} 内核支持（${o("Q2xhc2g=")} Verge Rev 建议在「设置 → 内核」切到 Alpha；${o("Q2xhc2g=")}Mi / Fl${o("Q2xhc2g=")} / ${o("U2hhZG93cm9ja2V0")} 亦可）。不支持的内核会整份配置拒载</p></div>
      <div class="card" style="border-color:var(--accent)">
        <h3><span class="tick"></span>接入进度</h3>
        <div class="hint">${o("TUFTUVVF")} 走<b>证书认证</b>：本服务会在首次拉取订阅时<b>自动完成注册</b>并把凭据写入你的存储，之后一直复用。你也可以在下面手工填入自己生成的凭据（优先级更高）；两者都没有时才回落到 WARP 节点，保证订阅不会空。</div>
      </div>
      <div class="grid3">
        <div class="card">
          <h3><span class="tick"></span>凭据（自动注册，可覆盖）</h3>
          <div class="field"><label class="spill"><input type="checkbox" id="x-on"> 启用 ${o("TUFTUVVF")} 节点下发</label></div>
          <div class="field"><label>粘贴本地生成的凭据（EC 私钥 / 公钥）</label>
            <textarea id="x-conf" rows="6" placeholder="留空则由本服务自动注册；注册失败时回落到 WARP 节点"></textarea>
          </div>
          <div class="field"><label>节点名称</label><input type="text" id="x-name" placeholder="${o("TUFTUVVF")}"></div>
          <div class="hint">不填也能用：留空时本服务自动注册。凭据只保存在你自己的存储中，不外发。</div>
        </div>
        <div class="card">
          <h3><span class="tick"></span>对端候选</h3>
          <div class="field"><label>一行一个「IP:端口」，按填写顺序尝试（最多 50 个）</label>
            <textarea id="x-eps" rows="6" placeholder="留空则使用内置官方端点组合"></textarea>
          </div>
          <div class="hint">${o("TUFTUVVF")} 的 IP 与端口和 WARP 不同，串用会连不上；留空即用内置的官方端点组合。</div>
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
              <option value="${o("bWFzcXVl")}">${o("TUFTUVVF")} 模式 — 下发 ${o("TUFTUVVF")} 节点，客户端直连</option>
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
      <div class="view-head"><h2>关于项目</h2><p>${Yr} — Cloudflare 边缘管理面板（独立界面 + 独立实现）</p></div>
      <div class="card">
        <h3><span class="tick"></span>相关链接</h3>
        <p style="font-size:13px;color:var(--dim)">${o("WW91VHViZQ==")} @数字派：<a href="https://www.${o("eW91dHViZQ==")}.com/@${o("UEFJX0NO")}" target="_blank" rel="noopener">${o("eW91dHViZQ==")}.com/@${o("UEFJX0NO")}</a></p>
        <p style="font-size:13px;color:var(--dim);margin-top:6px">Telegram 交流群：<a href="https://${o("dC5tZS8=")}${o("U1pfUEFJ")}" target="_blank" rel="noopener">${o("dC5tZS8=")}${o("U1pfUEFJ")}</a></p>
      </div>
      <div class="card">
        <h3><span class="tick"></span>特别鸣谢</h3>
        <p style="font-size:13px;color:var(--dim);margin-bottom:10px">感谢以下开源项目的启发与支持（界面与代码均为独立实现）</p>
        <div class="tbl-wrap"><table>
          <colgroup><col style="width:34%"><col style="width:66%"></colgroup>
          <thead><tr><th>开源项目</th><th>地址</th></tr></thead>
          <tbody>
            <tr><td>${o("SW9uUmg=")}/${o("Q2xvdWRmbGFyZS1CZXN0SVA=")}</td><td><a href="https://github.com/${o("SW9uUmg=")}/${o("Q2xvdWRmbGFyZS1CZXN0SVA=")}" target="_blank" rel="noopener">github.com/${o("SW9uUmg=")}/${o("Q2xvdWRmbGFyZS1CZXN0SVA=")}</a></td></tr>
            <tr><td>${o("enZvcw==")}/${o("Q0YtV29ya2Vycy1Nb25pdG9y")}</td><td><a href="https://github.com/${o("enZvcw==")}/${o("Q0YtV29ya2Vycy1Nb25pdG9y")}" target="_blank" rel="noopener">github.com/${o("enZvcw==")}/${o("Q0YtV29ya2Vycy1Nb25pdG9y")}</a></td></tr>
            <tr><td>${o("TWV0YUN1YmVY")}/${o("bWV0YS1ydWxlcy1kYXQ=")}</td><td><a href="https://github.com/${o("TWV0YUN1YmVY")}/${o("bWV0YS1ydWxlcy1kYXQ=")}" target="_blank" rel="noopener">github.com/${o("TWV0YUN1YmVY")}/${o("bWV0YS1ydWxlcy1kYXQ=")}</a></td></tr>
            <tr><td>${o("NjY2T1M=")}/rules</td><td><a href="https://github.com/${o("NjY2T1M=")}/rules" target="_blank" rel="noopener">github.com/${o("NjY2T1M=")}/rules</a></td></tr>
            <tr><td>${o("RHVzdGluV2lu")}/${o("cnVsZXNldF9nZW9kYXRh")}</td><td><a href="https://github.com/${o("RHVzdGluV2lu")}/${o("cnVsZXNldF9nZW9kYXRh")}" target="_blank" rel="noopener">github.com/${o("RHVzdGluV2lu")}/${o("cnVsZXNldF9nZW9kYXRh")}</a></td></tr>
            <tr><td>${o("YmxhY2ttYXRyaXg3")}/${o("aW9zX3J1bGVfc2NyaXB0")}</td><td><a href="https://github.com/${o("YmxhY2ttYXRyaXg3")}/${o("aW9zX3J1bGVfc2NyaXB0")}" target="_blank" rel="noopener">github.com/${o("YmxhY2ttYXRyaXg3")}/${o("aW9zX3J1bGVfc2NyaXB0")}</a></td></tr>
            <tr><td>${o("VEctVHdpbGlnaHQ=")}/${o("QVdBdmVudWU=")}-Ads-Rule</td><td><a href="https://github.com/${o("VEctVHdpbGlnaHQ=")}/${o("QVdBdmVudWU=")}-Ads-Rule" target="_blank" rel="noopener">github.com/${o("VEctVHdpbGlnaHQ=")}/${o("QVdBdmVudWU=")}-Ads-Rule</a></td></tr>
            <tr><td>${o("S29vbHNvbg==")}/${o("UXVyZQ==")}</td><td><a href="https://github.com/${o("S29vbHNvbg==")}/${o("UXVyZQ==")}" target="_blank" rel="noopener">github.com/${o("S29vbHNvbg==")}/${o("UXVyZQ==")}</a></td></tr>
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
            <tr><td>优选 IP 列表</td><td class="mono">cf.${o("MDkwMjI3")}.xyz/ip.164746.xyz</td></tr>
            <tr><td>${o("YmVzdGNm")} 地区优选池</td><td class="mono">${o("YmVzdGNm")}.pages.dev/random-region/{HK|TW|JP|SG|US|KR}/100.txt</td></tr>
            <tr><td>DoH 解析</td><td class="mono">cloudflare-dns.com / dns.alidns.com / doh.pub</td></tr>
            <tr><td>Cloudflare 用量监控（GraphQL）</td><td class="mono">api.cloudflare.com/client/v4/graphql</td></tr>
            <tr><td>版本更新检测</td><td class="mono">raw.githubusercontent.com/${o("UEFJQ05J")}/${o("Q0ZOZXh0")}/...</td></tr>
            <tr><td>远程规则集（${o("c2luZy1ib3g=")} / ${o("Q2xhc2g=")}）</td><td class="mono">raw.githubusercontent.com/${o("TWV0YUN1YmVY")}/${o("bWV0YS1ydWxlcy1kYXQ=")}/...</td></tr>
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
      <button class="mmodecard" onclick="pickMode('${o("bWFzcXVl")}')">
        <b>${o("TUFTUVVF")} 模式</b>
        <span>下发 ${o("TUFTUVVF")} 节点，同样由客户端直连。仅部分客户端支持，凭据同样自动生成与保管，无需自备配置。</span>
        <em>适合：明确知道自己的客户端支持</em>
      </button>
      <button class="mmodecard" onclick="pickMode('home')">
        <b>家宽模式</b>
        <span>下发 VPN Gate OpenVPN 家宽出口，经隧道前置拨号，客户端直连。</span>
        <em>适合：需要真实家宽出口（仅 ${o("TWlob21v")} 内核）</em>
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
    try { p = navigator.clipboard.writeText(t); } catch (e) { fin(${o("ZmFsbGJhY2s=")}Copy(t)); return; }
    if (p && typeof p.then === 'function') {
      p.then(function(){ fin(true); }, function(){ fin(${o("ZmFsbGJhY2s=")}Copy(t)); });
      setTimeout(function(){ fin(${o("ZmFsbGJhY2s=")}Copy(t)); }, 600); // 剪贴板 API 悬空（无权限等）时回退
    } else { fin(true); }
  } else {
    fin(${o("ZmFsbGJhY2s=")}Copy(t));
  }
}
function ${o("ZmFsbGJhY2s=")}Copy(t){
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
  { id:'${o("bWFzcXVl")}', name:'${o("TUFTUVVF")} 配置', icon:'<path d="M4 7l8-4 8 4v10l-8 4-8-4zM12 3v18"/>' },
  { id:'${o("aG9tZQ==")}', name:'家宽配置', icon:'<path d="M3 11l9-7 9 7M5 10v10h14V10M10 20v-6h4v6"/>' },
  { id:'nodes', name:'节点配置', icon:'<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9zM12 12l8-4.5M12 12L4 7.5"/>' },
  { id:'optimizer', name:'优选配置', icon:'<path d="M12 19a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM12 8v4l2.5 2.5M3 3l3 3"/>' },
  { id:'quota', name:'配额安全', icon:'<path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6zM9 12l2 2 4-4"/>' },
  { id:'account', name:'面板设置', icon:'<path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21c0-3.5 3.6-6 8-6s8 2.5 8 6"/>' },
  { id:'about', name:'关于项目', icon:'<path d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v5M12 8h.01"/>' }
];
var TITLES = { dashboard:'仪表盘', warp:'WARP 配置', ${o("bWFzcXVl")}:'${o("TUFTUVVF")} 配置', ${o("aG9tZQ==")}:'家宽配置', nodes:'节点配置', optimizer:'优选配置', quota:'配额安全', account:'面板设置', about:'关于项目' };

/* ===== 运行模式（四种模式互不影响，可随时切换） ===== */
var MODE_NAV = {
  worker: ['dashboard', 'nodes', 'optimizer', 'quota', 'account', 'about'],
  warp: ['dashboard', 'warp', 'account', 'about'],
  ${o("bWFzcXVl")}: ['dashboard', '${o("bWFzcXVl")}', 'account', 'about'],
  home: ['dashboard', '${o("aG9tZQ==")}', 'account', 'about']
};
var MODE_SHORT = { worker: 'Worker', warp: 'WARP', ${o("bWFzcXVl")}: '${o("TUFTUVVF")}', home: '家宽' };
var MODE_LABEL = { worker: 'Worker 模式', warp: 'WARP 模式', ${o("bWFzcXVl")}: '${o("TUFTUVVF")} 模式', home: '家宽模式' };
var MODE_DESC = {
  worker: '使用内置节点，由本服务承载转发，开箱即用。',
  warp: '下发 WARP 节点，客户端直连，流量不经过本服务。',
  ${o("bWFzcXVl")}: '下发 ${o("TUFTUVVF")} 节点，客户端直连；仅部分客户端支持。',
  home: 'VPN Gate OpenVPN 家宽出口，经隧道前置拨号（仅 ${o("TWlob21v")} 内核）。'
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
  // 地区与线路筛选只对内置 CF 节点池有意义：WARP / ${o("TUFTUVVF")} 的节点由客户端直连，不参与地区/来源筛选
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
  if (CFG.enable${o("Vmxlc3M=")} !== false) a.push('${o("VkxFU1M=")}');
  if (CFG.enable${o("VHJvamFu")}) a.push('${o("VHJvamFu")}');
  if (CFG.enable${o("WGh0dHA=")}) a.push('${o("WEhUVFA=")}');
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
  $('en-${o("dmxlc3M=")}').checked = CFG.enable${o("Vmxlc3M=")} !== false;
  $('en-${o("dHJvamFu")}').checked = !!CFG.enable${o("VHJvamFu")};
  $('tp-pass').value = CFG.${o("dHJvamFu")}Password || '';
  $('en-${o("eGh0dHA=")}').checked = !!CFG.enable${o("WGh0dHA=")};
  $('tls-only').checked = !!CFG.tlsOnly;
  $('${o("YWxwbg==")}').value = CFG.${o("YWxwbg==")} || '';
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
  $('o-fbpool').value = o.${o("ZmFsbGJhY2s=")}Pool || '';
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
  $('s-${o("cHJveHlJUA==")}').value = CFG.${o("cHJveHlJUA==")} || '';
  $('s-${o("b3V0Ym91bmQ=")}').value = CFG.${o("b3V0Ym91bmQ=")}Proxy || '';
  $('s-outmode').value = CFG.${o("b3V0Ym91bmQ=")}Mode || '';
  $('a-mode').value = curMode();
  $('w-on').checked = !!CFG.warpEnable;
  setWStat();
  $('w-eps').value = CFG.warpEps || '';
  $('w-front').value = CFG.warpFront || '';
  $('w-name').value = CFG.warpName || 'WARP';
  $('x-on').checked = !!CFG.${o("bWFzcXVl")}Enable;
  $('x-conf').value = CFG.${o("bWFzcXVl")}Conf || '';
  $('x-name').value = CFG.${o("bWFzcXVl")}Name || '${o("TUFTUVVF")}';
  $('x-eps').value = CFG.${o("bWFzcXVl")}Eps || '';
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
    ${o("bWFzcXVl")}Enable: $('x-on').checked,
    ${o("bWFzcXVl")}Conf: $('x-conf').value,
    ${o("bWFzcXVl")}Name: $('x-name').value.trim() || '${o("TUFTUVVF")}',
    ${o("bWFzcXVl")}Eps: $('x-eps').value,
    uuid: $('a-uuid').value.trim(),
    subUrl: $('a-suburl').value.trim(),
    admin: $('a-admin').value,
    ${o("YWxwbg==")}: $('${o("YWxwbg==")}').value,
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
    enable${o("Vmxlc3M=")}: $('en-${o("dmxlc3M=")}').checked,
    enable${o("VHJvamFu")}: $('en-${o("dHJvamFu")}').checked,
    ${o("dHJvamFu")}Password: $('tp-pass').value,
    enable${o("WGh0dHA=")}: $('en-${o("eGh0dHA=")}').checked,
    homeWan: $('hw-on').checked,
    hwCfg: $('hw-cfg').value,
    ${o("cHJveHlJUA==")}: $('s-${o("cHJveHlJUA==")}').value.trim(),
    ${o("b3V0Ym91bmQ=")}Proxy: $('s-${o("b3V0Ym91bmQ=")}').value.trim(),
    ${o("b3V0Ym91bmQ=")}Mode: $('s-outmode').value,
    preferredDomains: domLines.join('\n'),
    preferredIPs: ips,
    optimizer: {
      source: $('o-source').value,
      sourceURL: $('o-sourceURL').value.trim(),
      ${o("ZmFsbGJhY2s=")}Pool: $('o-fbpool').value.trim(),
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
    a.download = '${o("Y2ZuZXh0")}-backup-' + ts.getFullYear() + pad(ts.getMonth()+1) + pad(ts.getDate()) + '-' + pad(ts.getHours()) + pad(ts.getMinutes()) + '.json';
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
  // 填了 /sub 结尾或带前后斜杠时自动归一，格式后缀（${o("Y2xhc2g=")}/${o("c2luZ2JveA==")} 等）拼为 /sub/<格式>
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
// ${o("Q2xhc2g=")}/${o("TWlob21v")}、${o("U3Rhc2g=")} → ${o("Y2xhc2g=")}://install-config（Fly${o("Q2xhc2g=")} / ${o("Q2xhc2g=")} Verge / ${o("U3Rhc2g=")} 扫码装订阅，配置名取订阅响应头 filename=${o("Q0ZOZXh0")}）
// ${o("U2luZy1ib3g=")} → ${o("c2luZy1ib3g=")}://import-remote-profile?url=...#${o("Q0ZOZXh0")}（官方 scheme，# 后为配置文件名称）
// ${o("U3VyZ2U=")} → ${o("c3VyZ2U=")}:///install-config（${o("U3VyZ2U=")} 官方 scheme）
// auto / ${o("djJyYXlO")}+${o("U2hhZG93cm9ja2V0")} / ${o("TG9vbg==")} / ${o("UXVhbnR1bXVsdA==")} X / 明文 → 直接使用订阅链接（${o("U2hhZG93cm9ja2V0")} / ${o("TG9vbg==")} / ${o("UXVhblg=")} 扫码识别）
function qrPayloadOf(fmt, url){
  var enc = encodeURIComponent(url);
  if (fmt === '${o("Y2xhc2g=")}' || fmt === '${o("c3Rhc2g=")}') return '${o("Y2xhc2g=")}://install-config?url=' + enc;
  if (fmt === '${o("c2luZ2JveA==")}') return '${o("c2luZy1ib3g=")}://import-remote-profile?url=' + enc + '#' + __B;
  if (fmt === '${o("c3VyZ2U=")}') return '${o("c3VyZ2U=")}:///install-config?url=' + enc;
  return url;
}
function downloadSub(){
  var fmt = $('subFmt').value;
  var url = subUrlOf(fmt === 'auto' ? '' : fmt);
  // 保存名按所选格式给出（内容随管理接口返回，不再依赖响应头里的文件名）
  var names = { ${o("Y2xhc2g=")}:__B+'.yaml', ${o("c3Rhc2g=")}:__B+'.yaml', ${o("c2luZ2JveA==")}:__B+'.json', ${o("c3VyZ2U=")}:__B+'.conf', ${o("c3VyZmJvYXJk")}:__B+'.conf', ${o("bG9vbg==")}:__B+'.conf', ${o("cXVhbng=")}:__B+'.conf' };
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
      if (/${o("Y2xhc2g=")}|yaml/i.test(type)) n = (body.match(/- name:/g) || []).length;
      else if (/json/i.test(type)) n = (body.match(/"tag"/g) || []).length;
      else {
        var t = body;
        if (!/^(${o("dmxlc3M=")}|${o("dHJvamFu")}|ss|${o("eGh0dHA=")}):\/\//m.test(t)) {
          try { t = atob(t); } catch (e) { /* 保持原样 */ }
        }
        n = t.split('\n').filter(function(l){ return /^(${o("dmxlc3M=")}|${o("dHJvamFu")}|ss|${o("eGh0dHA=")}):\/\//.test(l.trim()); }).length;
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

`;Jt();async function qt(t,e,r,n,a,i){if((i?.impl??"vendor")==="self")return await Xt(t,e,r,n,a,i?.diagnostics);try{return fn(t,{uuid:r.uuid,enableTrojan:r.enableTrojan,trojanPassword:r.trojanPassword,proxyIP:r.proxyIp,outboundProxy:"",outboundMode:"",path:r.wsPath.replace(/^\//,"")})}catch{return new Response("\u670D\u52A1\u6682\u4E0D\u53EF\u7528",{status:503,headers:{"Content-Type":"text/plain; charset=utf-8"}})}}function Qt(t){let e=(t??"").trim().toLowerCase();return e==="vendor"||e==="cfnext"||e==="next"?"vendor":"self"}er();Gt();function tr(t){let e=[];return e.push(...Ee(t.proxyIp,"direct")),e.push(...Ee(t.socks5,"socks5")),e.push(...Ee(t.httpProxy,"http")),e}async function ea(t,e,r){let n=new URL(t.url);if(n.pathname==="/__edge_probe")return ze(t);if(n.pathname==="/__diag"){let{recentDiagnostics:c}=await Promise.resolve().then(()=>(Jt(),qn)),{recentXhttpDiagnostics:d}=await Promise.resolve().then(()=>(er(),Kn));return new Response(JSON.stringify({ok:!0,impl:Qt(e.DATAPLANE),recent:c(),xhttp:d()},null,2),{status:200,headers:{"Content-Type":"application/json; charset=utf-8"}})}let a=await jr(e),i=t.headers.get("Upgrade")?.toLowerCase(),s=Qt(e.DATAPLANE);return n.pathname===a.wsPath?i!=="websocket"?be("\u8BE5\u8DEF\u5F84\u9700\u8981 WebSocket \u5347\u7EA7",400):await qt(t,"vless",a,tr(a),r,{impl:s}):a.enableTrojan&&n.pathname===a.trojanPath?i!=="websocket"?be("\u8BE5\u8DEF\u5F84\u9700\u8981 WebSocket \u5347\u7EA7",400):await qt(t,"trojan",a,tr(a),r,{impl:s}):a.enableXhttp&&n.pathname===a.xhttpPath?t.method!=="POST"?be("XHTTP \u9700\u8981 POST \u8BF7\u6C42",405):await Kt(t,a,tr(a)):null}var Vs={async fetch(t,e,r){try{return await Zr(t,e)??await ea(t,e,r)??wt(200)}catch{return wt(500)}}};export{Vs as default};
