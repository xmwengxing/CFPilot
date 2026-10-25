var da=Object.defineProperty;var F=(t,e,r)=>()=>{if(r)throw r[0];try{return t&&(e=t(t=0)),e}catch(n){throw r=[n],n}};var st=(t,e)=>{for(var r in e)da(t,r,{get:e[r],enumerable:!0})};function ee(t){let e=new Uint8Array(t);crypto.getRandomValues(e);let r="";for(let n of e)r+=he[n>>4]+he[n&15];return r}function lt(){let t=new Uint8Array(16);crypto.getRandomValues(t),t[6]=t[6]&15|64,t[8]=t[8]&63|128;let e=[];for(let r of t)e.push(he[r>>4]+he[r&15]);return[e.slice(0,4).join(""),e.slice(4,6).join(""),e.slice(6,8).join(""),e.slice(8,10).join(""),e.slice(10,16).join("")].join("-")}function cr(t){let e="abcdefghijklmnopqrstuvwxyz0123456789",r=new Uint8Array(t);crypto.getRandomValues(r);let n="";for(let a of r)n+=e[a%e.length];return n}function dr(t){let e=new TextEncoder().encode(t),r="",n=32768;for(let a=0;a<e.length;a+=n)r+=String.fromCharCode(...e.subarray(a,a+n));return btoa(r)}async function pr(t){let e=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(t)),r=new Uint8Array(e),n="";for(let a of r)n+=he[a>>4]+he[a&15];return n}function ct(t,e){if(t.length!==e.length)return!1;let r=0;for(let n=0;n<t.length;n++)r|=t.charCodeAt(n)^e.charCodeAt(n);return r===0}var he,ge=F(()=>{"use strict";he="0123456789abcdef"});function xe(t,e){if(t==null)return e;let r=String(t).trim();if(r==="")return e;let n=Number(r);return Number.isFinite(n)?n:e}function te(t,e){if(t==null||t==="")return e;let r=String(t).trim().toLowerCase();return["1","true","yes","on"].includes(r)?!0:["0","false","no","off"].includes(r)?!1:e}function j(t,e){return t==null?e:String(t)}function pa(t){return{uuid:j(t.UUID,""),trojanPassword:j(t.TROJAN_PASSWORD,""),wsPath:j(t.WS_PATH||t.PATH,O.wsPath),trojanPath:O.trojanPath,xhttpPath:O.xhttpPath,add:j(t.ADD,""),addApi:j(t.ADDAPI,""),addCsv:j(t.ADD_CSV,""),poolOfficial:te(t.OFFICIAL_IP,O.poolOfficial),officialCount:xe(t.OFFICIAL_IP_COUNT,O.officialCount),poolDomain:te(t.PREFERRED_DOMAIN,O.poolDomain),domainCount:xe(t.PREFERRED_DOMAIN_COUNT,O.domainCount),poolManual:te(t.MANUAL_IP,O.poolManual),poolCountries:j(t.POOL_COUNTRIES,O.poolCountries),dls:xe(t.DLS,0),maxLatency:xe(t.MAX_LATENCY,0),maxNodes:0,proxyIp:j(t.PROXYIP,""),socks5:j(t.SOCKS5,""),httpProxy:j(t.HTTP_PROXY,""),nat64:j(t.NAT64,""),concurrentDial:te(t.TCP_CONCURRENT_DIAL,!0),resolvePreferred:te(t.RESOLVE_PREFERRED,O.resolvePreferred),relayPool:j(t.RELAY_POOL,""),useBuiltinRelay:te(t.USE_BUILTIN_RELAY,O.useBuiltinRelay),enableTrojan:te(t.ENABLE_TROJAN??t.TROJAN,O.enableTrojan),enableXhttp:te(t.ENABLE_XHTTP??t.XHTTP,O.enableXhttp),subDomain:"",subProtocol:"both",subTransport:"both",subVariants:j(t.SUB_VARIANTS,O.subVariants),subName:j(t.SUB_NAME,O.subName).trim()||O.subName,subPorts:j(t.SUB_PORTS,O.subPorts),clientFingerprint:O.clientFingerprint,ech:te(t.ECH,O.ech),echHost:j(t.ECH_HOST,O.echHost),echDns:j(t.ECH_DNS,O.echDns),tlsFragment:!1,tlsFragmentSize:O.tlsFragmentSize,tlsFragmentDelay:O.tlsFragmentDelay}}function ft(t,e){let r={...t};for(let[n,a]of Object.entries(e))if(a!=null)if(n==="dls"||n==="maxLatency"||n==="maxNodes"||n==="officialCount"||n==="domainCount")r[n]=xe(a,0);else if(n==="concurrentDial"||n==="resolvePreferred"||n==="useBuiltinRelay"||n==="enableTrojan"||n==="enableXhttp"||n==="tlsFragment"||n==="ech"||n==="poolOfficial"||n==="poolDomain"||n==="poolManual")r[n]=te(a,!1);else if(n==="subProtocol"){let i=String(a);r[n]=i==="vless"||i==="trojan"||i==="both"?i:"both"}else if(n==="subTransport"){let i=String(a);r[n]=i==="ws"||i==="xhttp"||i==="both"?i:"both"}else r[n]=String(a);return r}async function mr(t,e){let r=pa(e),n=await t.get(ur),a={};if(n)try{a=JSON.parse(n)}catch{a={}}let i=ft(r,a),s=!1;return i.uuid||(i.uuid=lt(),s=!0),i.trojanPassword||(i.trojanPassword=lt().replace(/-/g,"").slice(0,16),s=!0),i.officialCount<1&&(i.officialCount=O.officialCount,s=!0),i.domainCount<1&&(i.domainCount=O.domainCount,s=!0),s&&await mt(t,i),i}async function mt(t,e){await t.put(ur,JSON.stringify(e))}async function we(t){return await t.get(be)??""}async function ht(t){let e=await t.get(dt);return e?e.split(/\r?\n/).map(r=>r.trim()).filter(r=>r.length>0):[]}async function hr(t,e){let r=e.map(n=>n.trim()).filter(n=>n.length>0);if(r.length===0){await t.delete(dt);return}await t.put(dt,r.join(`
`))}var ur,be,pt,dt,Ne,Ve,Le,$e,ut,fr,O,ke=F(()=>{"use strict";ge();ur="CONFIG",be="LOCAL_PREFERRED_IPS",pt="SCANNER_TOKEN",dt="POOL_DOMAIN_LIBRARY",Ne="ONETIME:",Ve="SESSION:",Le="PANEL_PATH",$e="ADMIN_PW_HASH",ut="ADMIN_PW_PLAIN",fr="/cfpilot",O={uuid:"",trojanPassword:"",wsPath:"/vless",trojanPath:"/trojan",xhttpPath:"/xhttp",add:"",addApi:"",addCsv:"",poolOfficial:!0,officialCount:20,poolDomain:!0,domainCount:10,poolManual:!1,poolCountries:"",dls:0,maxLatency:0,maxNodes:0,proxyIp:"",socks5:"",httpProxy:"",nat64:"",concurrentDial:!0,resolvePreferred:!0,relayPool:"",useBuiltinRelay:!0,enableTrojan:!0,enableXhttp:!0,subDomain:"",subProtocol:"vless",subTransport:"ws",subVariants:"vless-ws",subName:"CFPilot",subPorts:"443",clientFingerprint:"chrome",ech:!1,echHost:"cloudflare-ech.com",echDns:"",tlsFragment:!1,tlsFragmentSize:"10-20",tlsFragmentDelay:"10-20"}});function Z(t){let e=ua.exec(t);if(!e)return!1;for(let r=1;r<=4;r++){let n=Number(e[r]);if(!Number.isInteger(n)||n<0||n>255)return!1}return!0}function B(t){return!t.includes(":")||!/^[0-9a-fA-F:.]+$/.test(t)?!1:fa(t)!==null}function fa(t){if(!t.includes(":"))return null;let e=t,r=e.lastIndexOf(":"),n=e.slice(r+1);if(n.includes(".")){if(!Z(n))return null;let p=n.split(".").map(f=>Number(f));e=`${e.slice(0,r+1)}${(p[0]<<8|p[1]).toString(16)}:${(p[2]<<8|p[3]).toString(16)}`}let a=e.indexOf("::"),i,s;if(a>=0){if(e.indexOf("::",a+1)>=0)return null;let p=e.slice(0,a),f=e.slice(a+2);i=p?p.split(":"):[],s=f?f.split(":"):[]}else i=e.split(":"),s=[];let d=i.length+s.length;if(d>8)return null;let c=[],u=p=>/^[0-9a-fA-F]{1,4}$/.test(p)?parseInt(p,16):null;for(let p of i){let f=u(p);if(f===null)return null;c.push(f)}let l=8-d;for(let p=0;p<l;p++)c.push(0);for(let p of s){let f=u(p);if(f===null)return null;c.push(f)}return c.length===8?c:null}function ma(t){let e=t.map(c=>(c&65535).toString(16)),r=-1,n=0,a=-1,i=0;for(let c=0;c<e.length;c++)e[c]==="0"?(a<0&&(a=c),i++,i>n&&(n=i,r=a)):(a=-1,i=0);if(n<2)return e.join(":");let s=e.slice(0,r).join(":"),d=e.slice(r+n).join(":");return`${s}::${d}`}function ha(t,e,r,n){if(e<0||e>=t.length)return null;if(r===1)return e+5>t.length?null:{hostname:`${t[e+1]}.${t[e+2]}.${t[e+3]}.${t[e+4]}`,next:e+5};if(n?r===2:r===3){if(e+2>t.length)return null;let a=t[e+1];return e+2+a>t.length?null:{hostname:new TextDecoder().decode(t.subarray(e+2,e+2+a)),next:e+2+a}}if(n?r===3:r===4){if(e+17>t.length)return null;let a=new DataView(t.buffer,t.byteOffset+e+1,16),i=[];for(let s=0;s<8;s++)i.push(a.getUint16(s*2,!1));return{hostname:ma(i),next:e+17}}return null}async function gt(t,e){let r=await t.peekExactly(1);if(!r)return null;let n=r[0],a;if(n===1)a=5;else if(e?n===2:n===3){let d=await t.peekExactly(2);if(!d)return null;a=2+d[1]}else if(e?n===3:n===4)a=17;else return null;let i=await t.peekExactly(a);if(!i)return null;let s=ha(i,0,n,e);return s?(t.skip(a),{hostname:s.hostname,addressType:n,consumed:a}):null}var ua,se=F(()=>{"use strict";ua=/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/});function Fe(t){return vr.get(t.toUpperCase())??""}function yr(t){return Object.prototype.hasOwnProperty.call(bt,t.toUpperCase())}var gr,Oe,Se,bt,br,vr,xr,vt=F(()=>{"use strict";gr=["104.16.0.1","104.16.32.1","104.16.64.1","104.16.128.1","104.16.192.1","104.17.0.1","104.17.32.1","104.17.64.1","104.17.128.1","104.17.192.1","104.18.0.1","104.18.64.1","104.19.0.1","104.19.64.1","104.20.0.1","104.20.64.1","104.21.0.1","104.21.64.1","104.22.0.1","104.22.64.1","104.23.0.1","104.23.64.1","104.24.0.1","104.25.0.1","104.27.19.224","172.66.0.1","172.67.0.1"],Oe=["104.16.0.0/11","104.24.0.0/14","172.66.0.0/15"],Se=["cf.090227.xyz","bestcf.top","cloudflare.182682.xyz","speed.marisalnc.com","freeyx.cloudflare88.eu.org","cdn.2020111.xyz","cfip.cfcdn.vip","cf.0sm.com","cf.zhetengsha.eu.org","cloudflare.9jy.cc","cf.zerone-cdn.pp.ua","cfip.1323123.xyz","cnamefuckxxs.yuchen.icu","cloudflare-ip.mofashi.ltd","115155.xyz","cname.xirancdn.us","f3058171cad.002404.xyz","8.889288.xyz","cdn.tzpro.xyz","cf.877771.xyz","xn--b6gac.eu.org"],bt={HK:["HKG"],TW:["TPE","KHH"],JP:["NRT","KIX","CTS","FUK"],KR:["ICN","PUS"],SG:["SIN"],MY:["KUL"],TH:["BKK"],VN:["SGN","HAN"],ID:["CGK","DPS"],PH:["MNL"],IN:["BOM","MAA","DEL"],AU:["SYD","MEL","BNE","PER"],NZ:["AKL"],US:["LAX","SJC","SEA","ORD","DFW","IAD","EWR","ATL","MIA","DEN","PHX","BOS"],CA:["YYZ","YVR","YYC"],GB:["LHR","MAN"],DE:["FRA","MUC","BER"],FR:["CDG","MRS"],NL:["AMS"],IT:["MXP","FCO"],ES:["MAD","BCN"],SE:["ARN"],CH:["ZRH"],AT:["VIE"],PL:["WAW"],RU:["DME","SVO"],TR:["IST"],AE:["DXB"],IL:["TLV"],ZA:["JNB"],BR:["GRU","GIG"],AR:["EZE"],CL:["SCL"],MX:["MEX"]},br={HK:"\u9999\u6E2F",TW:"\u53F0\u6E7E",JP:"\u65E5\u672C",KR:"\u97E9\u56FD",SG:"\u65B0\u52A0\u5761",MY:"\u9A6C\u6765\u897F\u4E9A",TH:"\u6CF0\u56FD",VN:"\u8D8A\u5357",ID:"\u5370\u5C3C",PH:"\u83F2\u5F8B\u5BBE",IN:"\u5370\u5EA6",AU:"\u6FB3\u5927\u5229\u4E9A",NZ:"\u65B0\u897F\u5170",US:"\u7F8E\u56FD",CA:"\u52A0\u62FF\u5927",GB:"\u82F1\u56FD",DE:"\u5FB7\u56FD",FR:"\u6CD5\u56FD",NL:"\u8377\u5170",IT:"\u610F\u5927\u5229",ES:"\u897F\u73ED\u7259",SE:"\u745E\u5178",CH:"\u745E\u58EB",AT:"\u5965\u5730\u5229",PL:"\u6CE2\u5170",RU:"\u4FC4\u7F57\u65AF",TR:"\u571F\u8033\u5176",AE:"\u963F\u8054\u914B",IL:"\u4EE5\u8272\u5217",ZA:"\u5357\u975E",BR:"\u5DF4\u897F",AR:"\u963F\u6839\u5EF7",CL:"\u667A\u5229",MX:"\u58A8\u897F\u54E5"},vr=new Map;for(let[t,e]of Object.entries(bt))for(let r of e)vr.set(r,t);xr=Object.keys(bt)});function xt(t){if(!/^\d{1,5}$/.test(t))return!1;let e=Number(t);return e>0&&e<=65535}function ze(t,e=de){let r=t.trim();if(!r||(r=r.replace(/^["']|["']$/g,"").trim(),!r||r.startsWith("#")))return null;let n="",a=r.indexOf("#");if(a>=0&&(n=r.slice(a+1).trim(),r=r.slice(0,a).trim()),!r)return null;if(r.startsWith("[")){let s=r.indexOf("]");if(s<0)return null;let d=r.slice(1,s),c=r.slice(s+1),u=e;if(c.startsWith(":")&&xt(c.slice(1)))u=Number(c.slice(1));else if(c)return null;return!B(d)&&!Z(d)?null:{ip:d,port:u,remark:n}}let i=(r.match(/:/g)??[]).length;if(i>1)return B(r)?{ip:r,port:e,remark:n}:null;if(i===1){let s=r.indexOf(":"),d=r.slice(0,s),c=r.slice(s+1);return!xt(c)||!Z(d)&&!B(d)&&!We(d)?null:{ip:d,port:Number(c),remark:n}}return!Z(r)&&!B(r)&&!We(r)?null:{ip:r,port:e,remark:n}}function We(t){return/^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/.test(t)}function ga(t){let e=t.split(/[_-]/).filter(Boolean),r="",n=0,a=0;if(e.length>=3){let i=Number(e[e.length-2]),s=Number(e[e.length-1]);Number.isFinite(i)&&Number.isFinite(s)&&(r=e.slice(0,e.length-2).join("_"),n=i,a=s)}else if(e.length===2){let i=Number(e[1]);Number.isFinite(i)&&(r=e[0]??"",n=i)}return{colo:r,latency:n,speed:a}}function wt(t,e){let r=ga(t.remark),n=r.colo.toUpperCase();return{ip:t.ip,port:t.port,remark:t.remark,colo:n,latency:r.latency,speed:r.speed,source:e,country:Fe(n)}}function ba(t){let e=[];for(let r of t.split(/\r?\n/)){let n=ze(r);n&&e.push(wt(n,"add"))}return e}function Ae(t){let e=[];for(let r of t.split(/\r?\n/)){let n=ze(r);n&&e.push(wt(n,"local"))}return e}function va(t){let e=[];for(let r of t.split(/\r?\n/)){let n=ze(r);n&&e.push(wt(n,"addapi"))}return e}function wa(t,e){let r=t.trim().toLowerCase().replace(/[（(].*?[)）]/g,"");for(let n of e)if(r===n||r.includes(n))return 1;return 0}function Pe(t,e){let r=-1,n=0;for(let a=0;a<t.length;a++){let i=wa(t[a],e);i>n&&(n=i,r=a)}return r}function yt(t){let e=t.replace(/[^\d.\-]/g,"");if(!e)return 0;let r=Number(e);return Number.isFinite(r)?r:0}function ka(t,e={}){let r=t.split(/\r?\n/).map(g=>g.trim()).filter(g=>g.length>0&&!g.startsWith("#")),n=[],a=0,i=!1,s=-1,d=-1,c=-1,u=-1,l=-1;if(r.length===0)return{entries:n,filtered:a,hasHeader:i};let p=Pr(r[0]),f=p.some(g=>Z(g.trim())||B(g.trim())),m=p.some(g=>wr.some(A=>g.toLowerCase().includes(A))||kr.some(A=>g.toLowerCase().includes(A))||Sr.some(A=>g.toLowerCase().includes(A))),b=0;m&&!f&&(i=!0,s=Pe(p,ya),d=Pe(p,xa),c=Pe(p,wr),u=Pe(p,kr),l=Pe(p,Sr),b=1);for(let g=b;g<r.length;g++){let A=Pr(r[g]);if(A.length===0)continue;let w="",U=de,T=0,y=0,k="";if(i){if(s<0)continue;if(w=(A[s]??"").trim(),d>=0&&A[d]){let S=Number(A[d].trim());Number.isInteger(S)&&S>0&&S<=65535&&(U=S)}c>=0&&A[c]&&(T=yt(A[c])),u>=0&&A[u]&&(y=yt(A[u])),l>=0&&A[l]&&(k=A[l].trim())}else{let S=A.findIndex(R=>{let N=R.trim();return Z(N)||B(N)||N.includes(".")&&We(N)});if(S<0)continue;w=A[S].trim();let P=[];A.forEach((R,N)=>{if(N===S)return;let V=yt(R);R.trim()&&/[\d.]/.test(R)&&P.push({index:N,value:V,raw:R})}),P.length===1?T=P[0].value:P.length===2?(T=P[0].value,y=P[1].value):P.length===3?(xt(P[0].raw.trim())&&(U=P[0].value),T=P[1].value,y=P[2].value):(y=P[P.length-2].value,T=P[P.length-1].value);let I=A.find((R,N)=>N!==S&&R.trim()&&!/[\d.]/.test(R)&&/[a-zA-Z]/.test(R));I&&(k=I.trim())}if(!w)continue;let E=ze(w.includes(":")&&!w.includes(" ")?w:`${w}:${U}`);if(!E)continue;let C={ip:E.ip,port:E.port,remark:k,colo:k.toUpperCase(),latency:y,speed:T,source:"addcsv",country:Fe(k.toUpperCase())};n.push(C)}let v=e.dls??0,x=e.maxLatency??0,h=n.filter(g=>!(v>0&&g.speed<v||x>0&&g.latency>x));return a=n.length-h.length,{entries:h,filtered:a,hasHeader:i}}function Pr(t){let e=[],r="",n=!1;for(let a=0;a<t.length;a++){let i=t[a];n?i==='"'?t[a+1]==='"'?(r+='"',a++):n=!1:r+=i:i==='"'?n=!0:i===","||i==="	"?(e.push(r.trim()),r=""):r+=i}return e.push(r.trim()),e}function He(t){if(t<=1)return 0;let e=new Uint32Array(1);return crypto.getRandomValues(e),e[0]%t}function Sa(t){let e=t.split(".");return(Number(e[0])<<24>>>0)+(Number(e[1])<<16)+(Number(e[2])<<8)+Number(e[3])}function Pa(t){let e=t>>>0;return`${e>>>24&255}.${e>>>16&255}.${e>>>8&255}.${e&255}`}function Aa(t,e){let r=[];for(let s of t){let[d,c]=s.split("/");if(!d||!Z(d))continue;let u=Number(c);!Number.isInteger(u)||u<8||u>32||r.push({base:Sa(d),hostBits:32-u})}if(r.length===0||e<=0)return[];let n=new Set,a=e*24,i=0;for(;n.size<e&&i<a;){i++;let{base:s,hostBits:d}=r[He(r.length)],c=2**d,u=d>=2?1+He(c-2):He(c);n.add(Pa(s+u))}return[...n]}function Ca(t,e=Se){let r=e.filter(n=>We(n));for(let n=r.length-1;n>0;n--){let a=He(n+1),i=r[n];r[n]=r[a],r[a]=i}return r.slice(0,Math.max(0,Math.min(t,r.length)))}function Ia(t){let e=[],r=new Set,n=[...gr];for(let a=n.length-1;a>0;a--){let i=Math.floor(Math.random()*(a+1));[n[a],n[i]]=[n[i],n[a]]}for(let a of n){if(e.length>=t)break;r.has(a)||(r.add(a),e.push(a))}if(e.length<t)for(let a of Aa(Oe,(t-e.length)*2)){if(e.length>=t)break;r.has(a)||(r.add(a),e.push(a))}return e.map(a=>({ip:a,port:de,remark:"",colo:"",latency:0,speed:0,source:"official",country:""}))}function Ta(t,e=Se){return Ca(t,e).map(r=>({ip:r,port:de,remark:"",colo:"",latency:0,speed:0,source:"domain",country:""}))}function Ua(t){return[...new Set(t.split(/[,\s]+/).map(e=>e.trim().toUpperCase()).filter(e=>e.length===2&&yr(e)))]}function Ea(t,e){if(e.length===0)return t;let r=new Set(e);return t.filter(n=>{let a=n.country||Fe(n.colo);return a!==""&&r.has(a)})}function Ma(t){let e=new Set,r=[],n=0;for(let a of t)for(let i of a.entries){let s=`${i.ip}:${i.port}`;if(e.has(s)){n++;continue}e.add(s),r.push(i)}return{nodes:r,deduped:n}}async function Ar(t,e){let r=await fetch(t,{signal:AbortSignal.timeout(e),headers:{"User-Agent":"CFPilot/1.1 (+https://github.com/xmwengxing/CFPilot)"}});if(!r.ok)throw new Error(`HTTP ${r.status}`);return await r.text()}function Cr(t,e,r){return Number.isFinite(t)?Math.min(r,Math.max(e,Math.trunc(t))):e}function Ir(t){return t.filter(e=>e.entries.length>0).map(e=>({key:e.key,name:Ra[e.key],entries:e.entries}))}async function _e(t,e,r={}){let n=r.timeoutMs??6e3,a=r.budget,i=[],s=Ua(t.poolCountries),d=t.poolOfficial||t.poolDomain||t.poolManual,c=d?t.poolOfficial?Cr(t.officialCount,1,200):0:20,u=d?t.poolDomain?Cr(t.domainCount,1,100):0:10,l=c>0?Ia(c):[],p=u>0?Ta(u,r.domainPool):[],f=Ae(e),m=ba(t.add),b=d?t.poolManual:!1,v=b?[...f,...m]:[];b&&v.length===0&&i.push("\u624B\u52A8\u4F18\u9009 IP \u4E3A\u7A7A\uFF1A\u8BF7\u5148\u8DD1\u4E00\u6B21\u672C\u5730\u771F\u8FDE\u63A5\u4F18\u9009\uFF0C\u6216\u5728\u300C\u624B\u52A8\u4F18\u9009\u300D\u91CC\u586B\u5165 IP");let x=[],h=t.addApi.split(/[\n,]+/).map(C=>C.trim()).filter(C=>/^https?:\/\//i.test(C));if(h.length>0&&!a?.exhausted){a?.pause();let C=[];try{C.push(...await Promise.allSettled(h.map(S=>Ar(S,n))))}finally{a?.resume()}for(let S of C)S.status==="fulfilled"?x=x.concat(va(S.value)):i.push(`ADDAPI \u62C9\u53D6\u5931\u8D25\uFF1A${String(S.reason?.message??S.reason)}`)}let g=[],A=0,w=t.addCsv.split(/[\n,]+/).map(C=>C.trim()).filter(C=>/^https?:\/\//i.test(C));if(w.length>0&&!a?.exhausted){a?.pause();let C=[];try{C.push(...await Promise.allSettled(w.map(S=>Ar(S,n))))}finally{a?.resume()}for(let S of C)if(S.status==="fulfilled"){let P=ka(S.value,{dls:t.dls,maxLatency:t.maxLatency});g=g.concat(P.entries),A+=P.filtered}else i.push(`ADDCSV \u62C9\u53D6\u5931\u8D25\uFF1A${String(S.reason?.message??S.reason)}`)}if(a?.exhausted&&(h.length>0||w.length>0)){let C=[h.length>0?`ADDAPI\xD7${h.length}`:"",w.length>0?`ADDCSV\xD7${w.length}`:""].filter(Boolean).join("\u3001");i.push(`CPU \u9884\u7B97\u4E0D\u8DB3\uFF08\u5DF2\u7528 ${a.elapsedMs.toFixed(1)}ms\uFF09\uFF0C\u5DF2\u8DF3\u8FC7\u8FDC\u7A0B\u62C9\u53D6\uFF1A${C}`)}let U=[{key:"official",entries:l},{key:"domain",entries:p},{key:"manual",entries:v},{key:"api",entries:x},{key:"csv",entries:g}],T=Ir(U);if(s.length>0&&T.length>0){let C=T.reduce((P,I)=>P+I.entries.length,0);T=T.map(P=>({...P,entries:Ea(P.entries,s)})).filter(P=>P.entries.length>0);let S=T.reduce((P,I)=>P+I.entries.length,0);S===0?(T=Ir(U),i.push(`\u56FD\u5BB6\u7B5B\u9009\uFF08${s.join("/")}\uFF09\u540E\u65E0\u53EF\u7528\u8282\u70B9\uFF1A\u968F\u673A\u4F18\u9009 IP \u7684\u673A\u623F\u672A\u77E5\uFF0C\u8BF7\u5148\u8DD1\u4E00\u6B21\u672C\u5730\u4F18\u9009\u518D\u6309\u56FD\u5BB6\u7B5B\u9009\uFF1B\u5DF2\u5FFD\u7565\u8BE5\u7B5B\u9009`)):S<C&&i.push(`\u56FD\u5BB6\u7B5B\u9009\uFF08${s.join("/")}\uFF09\u5DF2\u6392\u9664 ${C-S} \u6761\u673A\u623F\u672A\u77E5\u6216\u5730\u533A\u4E0D\u5339\u914D\u7684\u8282\u70B9`)}let{nodes:y,deduped:k}=Ma(T);return{nodes:t.maxNodes>0?y.slice(0,t.maxNodes):y,groups:T,stats:{official:l.length,domain:p.length,local:b?f.length:0,add:b?m.length:0,addapi:x.length,addcsv:g.length,filtered:A,deduped:k,countries:s,errors:i}}}function kt(t,e,r=Tr){let n=String(t??"").split(/[,;\s]+/).map(d=>d.trim().toLowerCase()).filter(Boolean),i=Tr.filter(d=>n.includes(d)).filter(d=>r.includes(d)?d==="trojan"?e.enableTrojan!==!1:d==="vless-xhttp"?e.enableXhttp!==!1:!0:!1);if(i.length>0)return i;let s=r.includes("vless-ws")?"vless-ws":r[0];return s?[s]:["vless-ws"]}function St(t){return t.groups&&t.groups.length>0?t.groups:[{key:"official",name:"\u8282\u70B9",entries:t.nodes}]}function Ce(t,e,r,n=""){let a=t.remark&&!/^[\d.]+$/.test(t.remark)?t.remark:t.ip,i=t.colo&&t.colo!==a?` ${t.colo}`:"";return`${n?`${n} `:""}${a}${i} #${r+1}${e==="trojan"?" Trojan":""}`}function Rr(t){return t.includes(":")?`[${t}]`:t}function Mr(t){let e=String(t.subPorts||"").split(/[\n,;\s]+/).map(n=>Number(n.trim())).filter(n=>Number.isInteger(n)&&n>0&&n<=65535),r=[...new Set(e)];return r.length>0?r:[de]}function Pt(t){return String(t||"").replace(/["\\\r\n]/g,"").trim().slice(0,64)||"CFPilot"}function At(t,e){return t.port!==de?[t.port]:e.ports.length>0?e.ports:[de]}function Dr(t){if(!t.config.ech)return"";let e=t.config.echHost.trim()||"cloudflare-ech.com",r=t.config.echDns.trim(),n=r?`${e}+${r}`:e;return`&ech=${encodeURIComponent(n)}`}function Ur(t,e,r,n){let a=r==="xhttp"?e.config.xhttpPath:e.config.wsPath,i=new URLSearchParams;i.set("encryption","none"),i.set("security","tls"),i.set("sni",e.domain),i.set("type",r),i.set("host",e.domain),i.set("path",a),r==="xhttp"&&i.set("mode","stream-one");let s=encodeURIComponent(n??Ce(t,"vless",e.nodes.indexOf(t)));return`${["vle","ss"].join("")}://${e.config.uuid}@${Rr(t.ip)}:${t.port}?${i.toString()}${Dr(e)}#${s}`}function Da(t,e,r){let n=new URLSearchParams;n.set("security","tls"),n.set("sni",e.domain),n.set("type","ws"),n.set("host",e.domain),n.set("path",e.config.trojanPath);let a=encodeURIComponent(r??Ce(t,"trojan",e.nodes.indexOf(t)));return`${["tro","jan"].join("")}://${encodeURIComponent(e.config.trojanPassword)}@${Rr(t.ip)}:${t.port}?${n.toString()}${Dr(e)}#${a}`}function K(t){return`"${t.replace(/\\/g,"\\\\").replace(/"/g,'\\"')}"`}function Na(t){let e=[],r=[],n=[],a=kt(t.config.subVariants,t.config,Er),i=a.some(p=>p==="vless-ws"),s=a.includes("trojan"),d=t.config.ech,c=t.config.echHost.trim()||"cloudflare-ech.com",u=t.config.echDns.trim(),l=()=>{if(!d)return[];let p=["    ech-opts:","      enable: true"];return p.push(`      query-server-name: ${K(c)}`),p};for(let p of St(t))p.entries.forEach((f,m)=>{let b=`${p.name} ${Ce(f,"vless",m,"")}`;for(let v of At(f,t)){let x=t.ports.length>1?`:${v}`:"",h=`${b}${x}`;if(i&&(n.push(h),r.push([`  - name: ${K(h)}`,"    type: vless",`    uuid: ${t.config.uuid}`,`    server: ${f.ip}`,`    port: ${v}`,"    network: ws","    tls: true",`    servername: ${t.domain}`,`    client-fingerprint: ${t.config.clientFingerprint}`,...l(),"    ws-opts:",`      path: ${K(t.config.wsPath)}`,"      headers:",`        Host: ${t.domain}`].join(`
`))),s){let g=`${h} Trojan`;n.push(g),r.push([`  - name: ${K(g)}`,"    type: trojan",`    password: ${K(t.config.trojanPassword)}`,`    server: ${f.ip}`,`    port: ${v}`,"    network: ws","    tls: true",`    sni: ${t.domain}`,`    client-fingerprint: ${t.config.clientFingerprint}`,...l(),"    ws-opts:",`      path: ${K(t.config.trojanPath)}`,"      headers:",`        Host: ${t.domain}`].join(`
`))}}});if(e.push("# CFPilot \u81EA\u52A8\u751F\u6210\u8BA2\u9605"),e.push("mixed-port: 7890"),e.push("allow-lan: false"),e.push("mode: rule"),e.push("log-level: info"),e.push("unified-delay: true"),e.push("tcp-concurrent: true"),e.push(""),e.push("dns:"),e.push("  enable: true"),e.push("  ipv6: false"),e.push("  enhanced-mode: fake-ip"),e.push("  fake-ip-range: 198.18.0.1/16"),e.push("  default-nameserver:"),e.push("    - 223.5.5.5"),e.push("    - 119.29.29.29"),e.push("  nameserver:"),e.push("    - https://223.5.5.5/dns-query"),e.push("    - https://dns.alidns.com/dns-query"),e.push("  fallback:"),e.push("    - 8.8.4.4"),e.push("    - 1.1.1.1"),e.push("  fallback-filter:"),e.push("    geoip: true"),e.push("    geoip-code: CN"),e.push(""),d&&(e.push("  nameserver-policy:"),e.push(`    ${K(c)}: ${u?K(u):"https://223.5.5.5/dns-query"}`),e.push("")),e.push("proxies:"),r.length===0?e.push("  []"):e.push(...r),e.push(""),e.push("proxy-groups:"),e.push('  - name: "CFPilot"'),e.push("    type: select"),e.push("    proxies:"),e.push('      - "\u81EA\u52A8\u9009\u62E9"'),e.push('      - "\u6545\u969C\u8F6C\u79FB"'),n.length===0)e.push("      []");else for(let p of n)e.push(`      - ${K(p)}`);if(n.length>0){e.push(""),e.push('  - name: "\u81EA\u52A8\u9009\u62E9"'),e.push("    type: url-test"),e.push('    url: "http://www.gstatic.com/generate_204"'),e.push("    interval: 300"),e.push("    tolerance: 50"),e.push("    proxies:");for(let p of n)e.push(`      - ${K(p)}`);e.push(""),e.push('  - name: "\u6545\u969C\u8F6C\u79FB"'),e.push("    type: fallback"),e.push('    url: "http://www.gstatic.com/generate_204"'),e.push("    interval: 300"),e.push("    proxies:");for(let p of n)e.push(`      - ${K(p)}`)}return e.push(""),e.push("rules:"),e.push("  - GEOIP,CN,DIRECT"),e.push("  - MATCH,CFPilot"),e.push(""),e.join(`
`)}function Va(t){let e=[],r=[],n=kt(t.config.subVariants,t.config,Er),a=n.some(l=>l==="vless-ws"),i=n.includes("trojan"),s=t.config.ech,d=t.config.echHost.trim()||"cloudflare-ech.com",c=()=>s?{ech:{enabled:!0,query_server_name:d}}:{};for(let l of St(t)){let p=[];l.entries.forEach((f,m)=>{let b=`${l.name} ${Ce(f,"vless",m,"")}`;for(let v of At(f,t)){let x=t.ports.length>1?`:${v}`:"",h=`${b}${x}`,g=`${h} Trojan`;a&&p.push(h),i&&p.push(g),a&&e.push({type:"vless",tag:h,server:f.ip,server_port:v,uuid:t.config.uuid,tls:{enabled:!0,server_name:t.domain,insecure:!1,utls:{enabled:!0,fingerprint:t.config.clientFingerprint},...c()},transport:{type:"ws",path:t.config.wsPath,headers:{Host:t.domain}}}),i&&e.push({type:"trojan",tag:g,server:f.ip,server_port:v,password:t.config.trojanPassword,tls:{enabled:!0,server_name:t.domain,insecure:!1,utls:{enabled:!0,fingerprint:t.config.clientFingerprint},...c()},transport:{type:"ws",path:t.config.trojanPath,headers:{Host:t.domain}}})}}),p.length>0&&r.push({tag:l.name,members:p})}e.push({type:"direct",tag:"direct"});for(let l of r)e.push({type:"selector",tag:l.tag,outbounds:l.members,default:l.members[0]});return e.push({type:"selector",tag:"CFPilot",outbounds:r.length>0?r.map(l=>l.tag):["direct"],default:r.length>0?r[0].tag:"direct"}),JSON.stringify({log:{level:"info",timestamp:!0},dns:{servers:[{tag:"dns-out",address:"https://1.1.1.1/dns-query"},{tag:"local",address:"local"}],rules:[{rule_set:[],server:"dns-out"}]},inbounds:[{type:"mixed",tag:"mixed-in",listen:"127.0.0.1",listen_port:2080}],outbounds:e,route:{rules:[{domain_suffix:[".cn"],outbound:"direct"}],final:"CFPilot",auto_detect_interface:!0}},null,2)}function La(t){let e=[],r=kt(t.config.subVariants,t.config);for(let n of St(t))n.entries.forEach((a,i)=>{let s=Ce(a,"vless",i,n.name);for(let d of At(a,t)){let c=t.ports.length>1?`:${d}`:"",u=`${s}${c}`,l={...a,port:d};for(let p of r)p==="vless-ws"?e.push(Ur(l,t,"ws",`${u} WS`)):p==="vless-xhttp"?e.push(Ur(l,t,"xhttp",`${u} XHTTP`)):e.push(Da(l,t,`${u} Trojan`))}});return dr(e.join(`
`))}function Nr(t,e){let r=Pt(e.config.subName);switch(t){case"clash":return{body:Na(e),contentType:"text/yaml; charset=utf-8",fileName:r};case"singbox":return{body:Va(e),contentType:"application/json; charset=utf-8",fileName:r};default:return{body:La(e),contentType:"text/plain; charset=utf-8",fileName:r}}}var de,ya,xa,wr,kr,Sr,Ra,Tr,Er,Ct=F(()=>{"use strict";se();ge();vt();de=443;ya=["ip\u5730\u5740","ip \u5730\u5740","ip","\u5730\u5740","\u670D\u52A1\u5668","server","host"],xa=["\u7AEF\u53E3","port"],wr=["\u4E0B\u8F7D\u901F\u5EA6","\u901F\u5EA6","speed","download"],kr=["\u5E73\u5747\u5EF6\u8FDF","\u5EF6\u8FDF","latency","delay","\u54CD\u5E94\u65F6\u95F4","rtt"],Sr=["colo","\u673A\u623F","\u6570\u636E\u4E2D\u5FC3","\u5730\u533A","region"];Ra={official:"\u5B98\u65B9\u4F18\u9009IP",domain:"\u4F18\u9009\u57DF\u540D",manual:"\u624B\u52A8\u4F18\u9009IP",api:"\u8FDC\u7A0BAPI",csv:"\u6D4B\u901FCSV"};Tr=["vless-ws","vless-xhttp","trojan"];Er=["vless-ws","trojan"]});function $r(t){return t.KV?new Tt(t.KV):new Ut}var Tt,Ut,Or=F(()=>{"use strict";Tt=class{constructor(e){this.kv=e}kv;async get(e){return await this.kv.get(e)}async put(e,r,n){n&&n>=60?await this.kv.put(e,r,{expirationTtl:n}):await this.kv.put(e,r)}async delete(e){await this.kv.delete(e)}async list(e){let r=[],n;do{let a=await this.kv.list({prefix:e,cursor:n});for(let i of a.keys)r.push(i.name);n=a.list_complete?void 0:a.cursor}while(n);return r}},Ut=class{data=new Map;async get(e){let r=this.data.get(e);return r?r.expiresAt>0&&r.expiresAt<=Date.now()?(this.data.delete(e),null):r.value:null}async put(e,r,n){let a=n?Date.now()+n*1e3:0;this.data.set(e,{value:r,expiresAt:a})}async delete(e){this.data.delete(e)}async list(e){return[...this.data.keys()].filter(r=>r.startsWith(e))}}});async function Et(t,e){return await pr(`${e}:${t}`)}function Fr(t){return`/${t.trim().replace(/^\/+/,"")}`}async function Wr(t,e,r){let n=await t.get(Le)??"",a=r&&r.trim()?Fr(r):"";a?n!==a&&(n=a,await t.put(Le,n)):n||(n=Fr(`${fr}-${cr(6)}`),await t.put(Le,n));let i=await t.get($e)??"",s=null,d=e&&e.trim()?e.trim():"";if(d){let c=ee(8);i=`${c}:${await Et(d,c)}`,await t.put($e,i),await t.delete(ut)}else if(!i){let c=`cfp-${ee(8)}`,u=ee(8);i=`${u}:${await Et(c,u)}`,await t.put($e,i),s=c,await t.put(ut,c)}return{panelPath:n,passwordHash:i,generatedPassword:s}}async function zr(t,e){let[r,n]=t.passwordHash.split(":");if(!r||!n)return!1;let a=await Et(e,r);return ct(a,n)}function _r(t){let e=t.headers.get("Cookie")??"",r={};for(let n of e.split(";")){let a=n.indexOf("=");if(a<0)continue;let i=n.slice(0,a).trim(),s=n.slice(a+1).trim();i&&(r[i]=decodeURIComponent(s))}return r}async function Gr(t){let e=ee(24);return await t.put(`${Ve}${e}`,JSON.stringify({ua:"",t:Date.now()}),Hr),e}async function Rt(t,e){let r=_r(e)[je];return r?!!await t.get(`${Ve}${r}`):!1}function Zr(t,e=Hr){return`${je}=${t}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${e}`}function jr(){return`${je}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`}async function Yr(t,e){let r=_r(e)[je];r&&await t.delete(`${Ve}${r}`)}async function Xr(t){let e=ee(20);return await t.put(`${Ne}${e}`,"1",Ha),e}async function Br(t,e){if(!e)return!1;let r=await t.get("SCANNER_TOKEN");return r&&ct(r,e)?!0:await t.get(`${Ne}${e}`)?(await t.delete(`${Ne}${e}`),!0):!1}var je,Hr,Ha,Mt=F(()=>{"use strict";ke();ge();je="cfpilot_sess",Hr=3600*24,Ha=600});function Dt(t){return $r(t)}async function Ye(t,e){if(q.config&&Date.now()-q.configAt<Wa)return q.config;let r=await mr(t,e);return q.config=r,q.configAt=Date.now(),r}function Jr(){q.config=null,q.configAt=0}async function Nt(t,e){if(q.auth&&Date.now()-q.authAt<za)return q.auth;let r=await Wr(t,e.PANEL_PASSWORD,e.PANEL_PATH);return q.auth=r,q.authAt=Date.now(),r}function Vt(t){switch((t??"").toLowerCase()){case"clash":case"mihomo":case"yaml":return"clash";case"singbox":case"sing-box":case"json":return"singbox";case"v2ray":return"v2ray";case"base64":return"base64";default:return"base64"}}function Ie(t){let e=String(t??"").trim();if(!e)return e;e=e.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//,""),e=e.replace(/[/?#].*$/,"");let r=e.lastIndexOf("@");if(r>=0&&(e=e.slice(r+1)),e.startsWith("[")){let n=e.indexOf("]");n>0&&(e=e.slice(1,n))}else{let n=e.indexOf(":");n>=0&&e.indexOf(":",n+1)<0&&(e=e.slice(0,n))}return e.trim()}function Qr(t){let e=(t??"").toLowerCase();return e?e.includes("clash")||e.includes("mihomo")||e.includes("flclash")||e.includes("clashx")||e.includes("stash")?"clash":e.includes("sing-box")||e.includes("singbox")?"singbox":e.includes("v2ray")||e.includes("v2rayng")||e.includes("shadowrocket")||e.includes("nekobox")||e.includes("surge")||e.includes("loon")||e.includes("quantumult")?"base64":null:null}var Wa,za,q,Xe=F(()=>{"use strict";Or();ke();Mt();Wa=15e3,za=6e4,q={config:null,configAt:0,auth:null,authAt:0}});async function Lt(t,e,r,n=!0){let a=t.getReader(),i=e.getWriter();try{for(;!r?.exhausted;){let{done:s,value:d}=await a.read();if(s)break;!d||d.byteLength===0||await i.write(d)}}catch{}finally{if(n)try{await i.close()}catch{}else try{i.releaseLock()}catch{}try{a.releaseLock()}catch{}}}var Be,$t=F(()=>{"use strict";Be=class{limitMs;anchor=performance.now();accumulated=0;paused=!1;constructor(e=8){this.limitMs=e}get elapsedMs(){return this.accumulated+(this.paused?0:performance.now()-this.anchor)}get exhausted(){return this.elapsedMs>this.limitMs}get remainingMs(){return this.limitMs-this.elapsedMs}pause(){this.paused||(this.accumulated+=performance.now()-this.anchor,this.paused=!0)}resume(){this.paused&&(this.anchor=performance.now(),this.paused=!1)}check(){if(this.exhausted)throw new Error(`CPU \u9884\u7B97\u8D85\u9650\uFF08${this.limitMs}ms\uFF09\uFF0C\u5DF2\u63D0\u524D\u4E2D\u6B62`)}}});var qr={};st(qr,{API_PREFIX:()=>Ot,getScannerToken:()=>_a,handleApi:()=>Ga});function J(t,e=200,r={}){return new Response(JSON.stringify(t),{status:e,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store",...r}})}function re(t,e){return J({ok:!1,error:t},e)}async function _a(t,e){let r=await t.get(pt);if(r)return r;if(typeof e.SCANNER_TOKEN=="string"&&e.SCANNER_TOKEN)return e.SCANNER_TOKEN;let n=ee(24);return await t.put(pt,n),n}async function Ga(t,e,r){if(!e.pathname.startsWith(Ot))return null;let{store:n,env:a,config:i,auth:s}=r,d=e.pathname.slice(Ot.length)||"/",c=t.method.toUpperCase();if(d==="/session"&&c==="GET"){let l=await Rt(n,t);return J({ok:!0,authenticated:l,panelPath:s.panelPath})}if(d==="/login"&&c==="POST"){let l="";try{let m=await t.json();l=String(m.password??"")}catch{return re("\u8BF7\u6C42\u4F53\u89E3\u6790\u5931\u8D25",400)}if(!l)return re("\u8BF7\u8F93\u5165\u5BC6\u7801",400);if(!await zr(s,l))return re("\u5BC6\u7801\u9519\u8BEF",401);let f=await Gr(n);return J({ok:!0},200,{"Set-Cookie":Zr(f)})}if(d==="/logout"&&c==="POST")return await Yr(n,t),J({ok:!0},200,{"Set-Cookie":jr()});if(d==="/preferred-ips"&&c==="POST"){let l=t.headers.get("Authorization")??"",p=l.startsWith("Bearer ")?l.slice(7).trim():l.trim();if(!await Br(n,p))return re("Token \u6821\u9A8C\u5931\u8D25",401);let m;try{m=await t.json()}catch{return re("\u8BF7\u6C42\u4F53\u89E3\u6790\u5931\u8D25",400)}let b=Array.isArray(m.ips)?m.ips.map(x=>String(x)):[],v=b.map(x=>x.trim()).filter(x=>x.length>0).join(`
`);return await n.put(be,v),J({ok:!0,count:b.length})}if(!await Rt(n,t))return re("\u672A\u767B\u5F55\u6216\u4F1A\u8BDD\u5DF2\u8FC7\u671F",401);if(d==="/status"&&c==="GET"){let l=await we(n),p=Ae(l),f=Ie(i.subDomain||a.DATA_HOST||e.hostname);return J({ok:!0,panelPath:s.panelPath,domain:e.hostname,nodeDomain:f,dataHost:a.DATA_HOST??"",colo:t.cf?.colo??"UNK",localIps:p.length,generatedPassword:s.generatedPassword,version:"0.1.0"})}if(d==="/config"&&c==="GET")return J({ok:!0,config:i});if(d==="/config"&&c==="PUT"){let l;try{l=await t.json()}catch{return re("\u8BF7\u6C42\u4F53\u89E3\u6790\u5931\u8D25",400)}if(!l.config||typeof l.config!="object")return re("\u7F3A\u5C11\u914D\u7F6E\u5BF9\u8C61",400);let p=ft(i,l.config);return await mt(n,p),r.onConfigChanged(),J({ok:!0,config:p})}if(d==="/ips"&&c==="GET"){let l=await we(n),p=Ae(l);return J({ok:!0,raw:l,count:p.length,entries:p})}if(d==="/ips"&&c==="DELETE")return await n.delete(be),J({ok:!0});if(d==="/nodes"&&c==="GET"){let l=await we(n),p=await ht(n),f=new Be(8),m=await _e(i,l,{budget:f,domainPool:p.length>0?p:void 0});return J({ok:!0,count:m.nodes.length,nodes:m.nodes.slice(0,200),groups:m.groups.map(b=>({key:b.key,name:b.name,count:b.entries.length})),stats:m.stats})}if(d==="/pool/meta"&&c==="GET"){let l=await ht(n);return J({ok:!0,countries:xr.map(p=>({code:p,name:br[p]??p})),limits:{officialCount:200,domainCount:100},builtin:{cidrs:Oe.length,domains:Se.length},customDomains:l})}if(d==="/pool/library"&&c==="PUT"){let l;try{l=await t.json()}catch{return re("\u8BF7\u6C42\u4F53\u89E3\u6790\u5931\u8D25",400)}let p=Array.isArray(l.domains)?l.domains.map(f=>String(f)):[];return await hr(n,p),J({ok:!0,count:p.filter(f=>f.trim()).length})}if(d==="/scanner-token"&&c==="POST"){let l=await Xr(n);return J({ok:!0,token:l,expiresIn:600})}return d==="/events"&&c==="GET"?await Za(t,n):re("\u63A5\u53E3\u4E0D\u5B58\u5728",404)}async function Za(t,e){let r=new TextEncoder,n="",a,i=new ReadableStream({async start(s){let d=()=>{a&&clearTimeout(a);try{s.close()}catch{}};t.signal.addEventListener("abort",d);let c=async()=>{try{let u=await we(e);if(u!==n){n=u;let l=Ae(u).length;s.enqueue(r.encode(`event: ips
data: ${JSON.stringify({count:l})}

`))}else s.enqueue(r.encode(`: keepalive

`))}catch{}t.signal.aborted||(a=setTimeout(()=>{c()},3e3))};await c()},cancel(){a&&clearTimeout(a)}});return new Response(i,{status:200,headers:{"Content-Type":"text/event-stream; charset=utf-8","Cache-Control":"no-store",Connection:"keep-alive","X-Accel-Buffering":"no"}})}var Ot,Kr=F(()=>{"use strict";Mt();ke();Ct();vt();ge();$t();Xe();Ot="/api/v1"});function Tn(t){let e=t.replace(/-/g,"").trim().toLowerCase();if(!/^[0-9a-f]{32}$/.test(e))return null;let r=new Uint8Array(16);for(let n=0;n<16;n++)r[n]=parseInt(e.slice(n*2,n*2+2),16);return r}function An(t){let e="";for(let r of t)e+=Pn[r>>4]+Pn[r&15];return e}async function Un(t,e){let r=await t.readExactly(1);if(!r)return null;let n=await t.readExactly(16);if(!n)return null;let a=Tn(e);if(!a||An(n)!==An(a))return null;let i=await t.readExactly(1);if(!i)return null;let s=i[0],d=s>0?await t.readExactly(s):new Uint8Array(0);if(!d)return null;let c=await t.readExactly(1);if(!c)return null;let u=await t.readExactly(2);if(!u)return null;let l=await gt(t,!0);if(!l)return null;let p=u[0]<<8|u[1];return{header:{version:r[0],command:c[0],port:p,hostname:l.hostname,addressType:l.addressType,addons:d},payload:t.release()}}function En(t,e){if(t.byteLength<18)return null;let r=Tn(e);if(!r)return null;for(let u=0;u<16;u++)if(t[1+u]!==r[u])return null;let n=t[17],a=18+n;if(t.byteLength<a+4)return null;let i=t[a];a+=1;let s=t[a]<<8|t[a+1];a+=2;let d=t[a];a+=1;let c="";if(d===1){if(t.byteLength<a+4)return null;c=`${t[a]}.${t[a+1]}.${t[a+2]}.${t[a+3]}`,a+=4}else if(d===2){if(t.byteLength<a+1)return null;let u=t[a];if(a+=1,t.byteLength<a+u)return null;c=new TextDecoder().decode(t.subarray(a,a+u)),a+=u}else if(d===3){if(t.byteLength<a+16)return null;let u=[];for(let l=0;l<8;l++)u.push((t[a+l*2]<<8|t[a+l*2+1]).toString(16));c=u.join(":"),a+=16}else return null;return{header:{version:t[0],command:i,port:s,hostname:c,addressType:d,addons:t.subarray(18,18+n)},consumed:a}}var Cn,In,Pn,Gt=F(()=>{"use strict";se();Cn=1,In=2,Pn="0123456789abcdef"});function ne(t,e){return t>>>e|t<<32-e}function uo(t){let e=new Uint32Array([3238371032,914150663,812702999,4144912697,4290775857,1750603025,1694076839,3204075428]),r=t.length*8,n=Math.ceil((t.length+9)/64)*64,a=new Uint8Array(n);a.set(t),a[t.length]=128;let i=new DataView(a.buffer);i.setUint32(n-8,Math.floor(r/4294967296),!1),i.setUint32(n-4,r>>>0,!1);let s=new Uint32Array(64);for(let c=0;c<n;c+=64){for(let h=0;h<16;h++)s[h]=i.getUint32(c+h*4,!1);for(let h=16;h<64;h++){let g=ne(s[h-15],7)^ne(s[h-15],18)^s[h-15]>>>3,A=ne(s[h-2],17)^ne(s[h-2],19)^s[h-2]>>>10;s[h]=s[h-16]+g+s[h-7]+A>>>0}let u=e[0],l=e[1],p=e[2],f=e[3],m=e[4],b=e[5],v=e[6],x=e[7];for(let h=0;h<64;h++){let g=ne(m,6)^ne(m,11)^ne(m,25),A=m&b^~m&v,w=x+g+A+po[h]+s[h]>>>0,U=ne(u,2)^ne(u,13)^ne(u,22),T=u&l^u&p^l&p,y=U+T>>>0;x=v,v=b,b=m,m=f+w>>>0,f=p,p=l,l=u,u=w+y>>>0}e[0]=e[0]+u>>>0,e[1]=e[1]+l>>>0,e[2]=e[2]+p>>>0,e[3]=e[3]+f>>>0,e[4]=e[4]+m>>>0,e[5]=e[5]+b>>>0,e[6]=e[6]+v>>>0,e[7]=e[7]+x>>>0}let d=new Uint8Array(28);for(let c=0;c<7;c++)d[c*4]=e[c]>>>24&255,d[c*4+1]=e[c]>>>16&255,d[c*4+2]=e[c]>>>8&255,d[c*4+3]=e[c]&255;return d}function Mn(t){let e=uo(t),r="";for(let n of e)r+=Rn[n>>4]+Rn[n&15];return r}var po,Rn,Dn=F(()=>{"use strict";po=new Uint32Array([1116352408,1899447441,3049323471,3921009573,961987163,1508970993,2453635748,2870763221,3624381080,310598401,607225278,1426881987,1925078388,2162078206,2614888103,3248222580,3835390401,4022224774,264347078,604807628,770255983,1249150122,1555081692,1996064986,2554220882,2821834349,2952996808,3210313671,3336571891,3584528711,113926993,338241895,666307205,773529912,1294757372,1396182291,1695183700,1986661051,2177026350,2456956037,2730485921,2820302411,3259730800,3345764771,3516065817,3600352804,4094571909,275423344,430227734,506948616,659060556,883997877,958139571,1322822218,1537002063,1747873779,1955562222,2024104815,2227730452,2361852424,2428436474,2756734187,3204031479,3329325298]),Rn="0123456789abcdef"});function fo(t){return Mn(new TextEncoder().encode(t))}function Vn(t,e){if(t.byteLength<58)return null;let r=fo(e);if(new TextDecoder().decode(t.subarray(0,56)).trim().toLowerCase()!==r||t[56]!==13||t[57]!==10)return null;let a=58;if(t.byteLength<a+2)return null;let i=t[a];a+=1;let s=t[a];a+=1;let d="";if(s===1){if(t.byteLength<a+4)return null;d=`${t[a]}.${t[a+1]}.${t[a+2]}.${t[a+3]}`,a+=4}else if(s===3){if(t.byteLength<a+1)return null;let u=t[a];if(a+=1,t.byteLength<a+u)return null;d=new TextDecoder().decode(t.subarray(a,a+u)),a+=u}else if(s===4){if(t.byteLength<a+16)return null;let u=[];for(let l=0;l<8;l++)u.push((t[a+l*2]<<8|t[a+l*2+1]).toString(16));d=u.join(":"),a+=16}else return null;if(t.byteLength<a+4)return null;let c=t[a]<<8|t[a+1];return a+=2,t[a]!==13||t[a+1]!==10?null:(a+=2,{header:{command:i,port:c,hostname:d,addressType:s},consumed:a})}var Nn,Ln=F(()=>{"use strict";se();Dn();Nn=3});function Zt(t,e){if(t.byteLength===0)return e;if(e.byteLength===0)return t;let r=new Uint8Array(new ArrayBuffer(t.byteLength+e.byteLength));return r.set(t,0),r.set(e,t.byteLength),r}var ce,Ue=F(()=>{"use strict";ce=class{reader;chunks=[];size=0;done=!1;constructor(e){this.reader=e.getReader()}async readExactly(e){if(e===0)return new Uint8Array(0);for(;this.size<e;){if(this.done)return null;let{done:r,value:n}=await this.reader.read();if(r)return this.done=!0,this.size>=e?this.take(e):null;n&&n.byteLength>0&&(this.chunks.push(n),this.size+=n.byteLength)}return this.take(e)}take(e){let r=new Uint8Array(e),n=0;for(;n<e;){let a=this.chunks[0],i=e-n;a.byteLength<=i?(r.set(a,n),n+=a.byteLength,this.chunks.shift()):(r.set(a.subarray(0,i),n),this.chunks[0]=a.subarray(i),n+=i)}return this.size-=e,r}async peekExactly(e){if(e===0)return new Uint8Array(0);for(;this.size<e;){if(this.done)return null;let{done:r,value:n}=await this.reader.read();if(r)return this.done=!0,this.size>=e?this.slice(e):null;n&&n.byteLength>0&&(this.chunks.push(n),this.size+=n.byteLength)}return this.slice(e)}skip(e){return this.size<e?null:this.take(e)}slice(e){let r=new Uint8Array(e),n=0;for(let a of this.chunks){if(n>=e)break;let i=Math.min(a.byteLength,e-n);r.set(a.subarray(0,i),n),n+=i}return r}peek(){if(this.chunks.length===0)return new Uint8Array(0);let e=this.chunks.reduce((a,i)=>a+i.byteLength,0),r=new Uint8Array(e),n=0;for(let a of this.chunks)r.set(a,n),n+=a.byteLength;return r}release(){let e=this.peek();this.chunks=[],this.size=0;let r=this.reader,n=this,a=!1;return new ReadableStream({async pull(i){if(!a&&(a=!0,e.byteLength>0)){i.enqueue(e);return}if(n.done){i.close();return}try{let{done:s,value:d}=await r.read();s?(n.done=!0,i.close()):d&&d.byteLength>0&&i.enqueue(d)}catch(s){i.error(s)}},cancel(i){r.cancel(i)}})}}});async function fe(t,e,r,n){let a=Date.now()+r,i=await Promise.race([t.readExactly(e),new Promise(s=>setTimeout(()=>s(null),Math.max(1,a-Date.now())))]);if(i===null)throw new Error(`${n}\u8D85\u65F6\uFF08${r}ms \u65E0\u54CD\u5E94\uFF09`);return i}async function $n(t,e,r,n,a={}){let i=new ce(t),s=e.getWriter(),d=a.handshakeTimeoutMs??mo,c=async u=>{await s.write(u)};try{let u=[0];a.username&&u.push(2);let l=new Uint8Array(2+u.length);l[0]=5,l[1]=u.length,l.set(u,2),await c(l);let p=await fe(i,2,d,"SOCKS5 \u63E1\u624B");if(!p||p[0]!==5)throw new Error("SOCKS5 \u63E1\u624B\u5931\u8D25\uFF1A\u975E\u6CD5\u54CD\u5E94");let f=p[1];if(f===2){let h=new TextEncoder().encode(a.username??""),g=new TextEncoder().encode(a.password??""),A=new Uint8Array(3+h.length+g.length);A[0]=1,A[1]=h.length,A.set(h,2),A[2+h.length]=g.length,A.set(g,3+h.length),await c(A);let w=await fe(i,2,d,"SOCKS5 \u8BA4\u8BC1");if(!w||w[1]!==0)throw new Error("SOCKS5 \u7528\u6237\u540D/\u5BC6\u7801\u8BA4\u8BC1\u5931\u8D25")}else if(f!==0)throw new Error(`SOCKS5 \u4E0D\u652F\u6301\u7684\u8BA4\u8BC1\u65B9\u5F0F\uFF1A0x${f.toString(16)}`);let m=ho(r,n),b=new Uint8Array(3+m.length);b[0]=5,b[1]=1,b[2]=0,b.set(m,3),await c(b);let v=await fe(i,4,d,"SOCKS5 CONNECT");if(!v||v[0]!==5)throw new Error("SOCKS5 CONNECT \u54CD\u5E94\u975E\u6CD5");if(v[1]!==0)throw new Error(`SOCKS5 CONNECT \u5931\u8D25\uFF1A0x${v[1].toString(16)}`);let x=v[3];if(x===1)await fe(i,4,d,"SOCKS5 \u54CD\u5E94");else if(x===3){let h=await fe(i,1,d,"SOCKS5 \u54CD\u5E94");if(!h)throw new Error("SOCKS5 \u54CD\u5E94\u622A\u65AD");await fe(i,h[0],d,"SOCKS5 \u54CD\u5E94")}else if(x===4)await i.readExactly(16);else throw new Error("SOCKS5 \u54CD\u5E94\u5730\u5740\u7C7B\u578B\u975E\u6CD5");return await fe(i,2,d,"SOCKS5 \u54CD\u5E94"),i.release()}finally{try{s.releaseLock()}catch{}}}function ho(t,e){if(Z(t)){let a=t.split(".").map(s=>Number(s)),i=new Uint8Array(7);return i[0]=1,i.set(a,1),i[5]=e>>8&255,i[6]=e&255,i}if(B(t)){let a=new Uint8Array(19);a[0]=4;let i=t.split(":").filter(Boolean);for(let s=0;s<8;s++){let d=parseInt(i[s]??"0",16)||0;a[1+s*2]=d>>8&255,a[2+s*2]=d&255}return a[17]=e>>8&255,a[18]=e&255,a}let r=new TextEncoder().encode(t),n=new Uint8Array(2+r.length+2);return n[0]=3,n[1]=r.length,n.set(r,2),n[n.length-2]=e>>8&255,n[n.length-1]=e&255,n}var mo,On=F(()=>{"use strict";Ue();se();mo=6e3});async function Fn(t,e,r,n,a={}){let i=new ce(t),s=e.getWriter(),d=`${r}:${n}`;try{let c=a.username&&a.password?`Proxy-Authorization: Basic ${btoa(`${a.username}:${a.password}`)}\r
`:"",u=[`CONNECT ${d} HTTP/1.1`,`Host: ${d}`,"Proxy-Connection: keep-alive","User-Agent: CFPilot/1.0",c,"",""].join(`\r
`);await s.write(new TextEncoder().encode(u));let l=[],p=Date.now()+jt;for(let v=0;v<8192;v++){if(Date.now()>p)throw new Error(`HTTP \u4EE3\u7406\u63E1\u624B\u8D85\u65F6\uFF08${jt}ms \u65E0\u54CD\u5E94\uFF09`);let x=await Promise.race([i.readExactly(1),new Promise(g=>setTimeout(()=>g(null),Math.max(1,p-Date.now())))]);if(!x){let g=await Promise.race([i.readExactly(1),new Promise(A=>setTimeout(()=>A(null),200))]);if(!g)throw new Error(`HTTP \u4EE3\u7406\u63E1\u624B\u8D85\u65F6\uFF08${jt}ms \u65E0\u54CD\u5E94\uFF09`);l.push(g[0]);continue}l.push(x[0]);let h=l.length;if(h>=4&&l[h-4]===et[0]&&l[h-3]===et[1]&&l[h-2]===et[2]&&l[h-1]===et[3])break}let m=new TextDecoder().decode(new Uint8Array(l)).split(`\r
`)[0]??"",b=/^HTTP\/1\.[01]\s+(\d{3})/.exec(m);if(!b)throw new Error("HTTP \u4EE3\u7406\u54CD\u5E94\u975E\u6CD5");if(b[1]!=="200")throw new Error(`HTTP \u4EE3\u7406 CONNECT \u5931\u8D25\uFF1A${b[1]}`);return i.release()}finally{try{s.releaseLock()}catch{}}}var et,jt,Hn=F(()=>{"use strict";Ue();et=[13,10,13,10],jt=6e3});function vo(t){return/^\d{1,3}(\.\d{1,3}){3}$/.test(t)?!0:t.includes(":")&&/^[0-9a-fA-F:.]+$/.test(t)}function yo(t,e){let r=t.trim(),n=/^\[([^\]]+)\](?::(\d+))?$/.exec(r);if(n)return{host:n[1],port:Number(n[2]??e)};if(r.includes(":")&&r.split(":").length>2)return{host:r,port:e};let a=r.lastIndexOf(":");if(a<0)return{host:r,port:e};let i=r.slice(0,a),s=Number(r.slice(a+1));return i?{host:i,port:Number.isInteger(s)&&s>0?s:e}:{host:r,port:e}}async function xo(t,e,r,n=zn){try{let a=`${t}?name=${encodeURIComponent(e)}&type=${r}`,i=await fetch(a,{headers:{accept:"application/dns-json"},signal:AbortSignal.timeout(n)});if(!i.ok)return[];let s=await i.json();if(!s||s.Status!==0||!Array.isArray(s.Answer))return[];let d=r==="TXT"?16:r==="A"?1:28;return s.Answer.filter(c=>c.type===d).map(c=>String(c.data))}catch{return[]}}async function Yt(t,e,r={}){for(let n of go){if(r.deadline!==void 0&&Date.now()>=r.deadline)break;let a=r.timeoutMs??zn,i=r.deadline!==void 0?r.deadline-Date.now():Number.POSITIVE_INFINITY,s=Math.max(50,Math.min(a,i)),d=await xo(n,t,e,s);if(d.length>0)return d}return[]}function wo(t,e){let r=[],n=String(t).replace(/^"|"$/g,"").replace(/\\010/g,",").replace(/\\n/g,",").trim();if(!n||n==="@edgetunnel")return r;let a=n.split(/[,;\s]+/).filter(Boolean);if(a.length===0)return r;for(let i of a){let s=i.trim();if(!s)continue;let{host:d,port:c}=yo(s,e);if(!Z(d)&&!B(d))return[];r.push({hostname:d,port:c})}return r}async function tt(t,e,r={}){let n=t.trim();if(!n)return[];if(vo(n))return[{hostname:n,port:e}];let a=`${n}:${e}`,i=Wn.get(a);if(i&&Date.now()-i.at<bo)return i.ips;let s=[];if(!r.skipTxt){let u=await Yt(n,"TXT",r);for(let l of u){let p=wo(l,e);if(p.length>0){s.push(...p);break}if(String(l).replace(/^"|"$/g,"").replace(/\\010/g,",").trim()==="@edgetunnel")break}}if(s.length===0){let u=await Yt(n,"A",r);for(let l of u)Z(l)&&s.push({hostname:l,port:e})}if(s.length===0){let u=await Yt(n,"AAAA",r);for(let l of u)B(l)&&s.push({hostname:l,port:e})}let d=[],c=new Set;for(let u of s){let l=`${u.hostname}:${u.port}`;c.has(l)||(c.add(l),d.push(u))}return d.length>0&&Wn.set(a,{at:Date.now(),ips:d}),d}var go,zn,bo,Wn,Xt=F(()=>{"use strict";se();go=["https://cloudflare-dns.com/dns-query","https://dns.alidns.com/resolve","https://doh.pub/dns-query"],zn=4e3,bo=300*1e3,Wn=new Map});function Zn(t){let e=String(t??"").toUpperCase();return e?So[e]??(/^[A-Z]{2}$/.test(e)?e:"US"):"US"}async function Gn(t,e=443,r=jn,n={}){let a=t.trim();if(!a)return[];let i=`${a}:${e}:${r}`,s=_n.get(i);if(s&&Date.now()-s.at<Co)return s.ips;let d=a,c=e,u=(a.match(/:/g)??[]).length;if(u===1){let p=/^(.*):(\d{1,5})$/.exec(a);p&&(d=p[1],c=Number(p[2]))}else if(u>1&&a.startsWith("[")){let p=/^\[([^\]]+)\]:(\d{1,5})$/.exec(a);p&&(d=p[1],c=Number(p[2]))}let l=[];if(Z(d)||B(d))l=[{ip:d,port:Number.isInteger(c)&&c>0?c:e,label:a}];else try{l=(await tt(d,c,{skipTxt:n.skipTxt,deadline:n.deadline,timeoutMs:n.timeoutMs})).slice(0,r).map(f=>({ip:f.hostname,port:f.port,label:`${d} \u2192 ${f.hostname}`}))}catch{l=[]}return l.length>0&&_n.set(i,{at:Date.now(),ips:l}),l}function Io(t,e=Yn){let r=Zn(t),n=a=>{let i=rt[a];return i?i===r?0:Object.keys(rt).findIndex(c=>rt[c]===i)+1:999};return ko.map((a,i)=>({d:a,i,rank:n(a)})).sort((a,i)=>a.rank!==i.rank?a.rank-i.rank:a.i-i.i).map(a=>a.d).slice(0,Math.max(0,e))}async function nt(t={}){let e=t.perDomain??jn,r=[],n=new Set,a=m=>{for(let b of m){let v=`${b.ip}:${b.port}`;n.has(v)||(n.add(v),r.push(b))}},i=(t.userEntries??"").trim(),s=i?i.split(/[\n,;]+/).map(m=>m.trim()).filter(Boolean):[],d=t.domainLimit??Yn,c=t.useBuiltin!==!1?Io(t.colo,d):[],u=m=>t.perDomain!==void 0?e:rt[m]===Zn(t.colo)?Po:Ao,l=await Promise.all([...s.map(m=>Gn(m,443,e,{deadline:t.deadline,timeoutMs:t.timeoutMs})),...c.map(m=>Gn(m,443,u(m),{skipTxt:!0,deadline:t.deadline,timeoutMs:t.timeoutMs}))]);for(let m=0;m<s.length;m++)a(l[m]);let p=l.slice(s.length),f=p.reduce((m,b)=>Math.max(m,b.length),0);for(let m=0;m<f;m++)for(let b of p)m<b.length&&a([b[m]]);return r}var rt,ko,So,jn,Ee,Yn,Po,Ao,Co,_n,Bt=F(()=>{"use strict";se();Xt();rt={"proxyip.hk.cmliussss.net":"HK","proxyip.us.cmliussss.net":"US","proxyip.sg.cmliussss.net":"SG","proxyip.jp.cmliussss.net":"JP","proxyip.kr.cmliussss.net":"KR","proxyip.de.cmliussss.net":"DE","proxyip.se.cmliussss.net":"SE","proxyip.nl.cmliussss.net":"NL","proxyip.fi.cmliussss.net":"FI","proxyip.gb.cmliussss.net":"GB","proxyip.oracle.cmliussss.net":"Oracle","proxyip.digitalocean.cmliussss.net":"DigitalOcean","proxyip.vultr.cmliussss.net":"Vultr","proxyip.multacom.cmliussss.net":"Multacom"},ko=["proxyip.hk.cmliussss.net","proxyip.jp.cmliussss.net","proxyip.sg.cmliussss.net","proxyip.us.cmliussss.net","proxyip.de.cmliussss.net","proxyip.gb.cmliussss.net","proxyip.kr.cmliussss.net","proxyip.nl.cmliussss.net","proxyip.se.cmliussss.net","proxyip.fi.cmliussss.net","proxyip.oracle.cmliussss.net","proxyip.digitalocean.cmliussss.net","proxyip.vultr.cmliussss.net","proxyip.multacom.cmliussss.net"],So={HKG:"HK",SYD:"AU",MEL:"AU",BNE:"AU",PER:"AU",ADL:"AU",CBR:"AU",SIN:"SG",NRT:"JP",HND:"JP",KIX:"JP",TYO:"JP",OSA:"JP",NGO:"JP",CTS:"JP",FUK:"JP",OKA:"JP",ICN:"KR",SEL:"KR",PUS:"KR",FRA:"DE",MUC:"DE",DUS:"DE",BER:"DE",HAM:"DE",STR:"DE",VIE:"DE",ZRH:"DE",CDG:"FR",MAD:"ES",MXP:"IT",FCO:"IT",PRG:"CZ",WAW:"PL",ARN:"SE",AMS:"NL",HEL:"FI",LHR:"GB",LGW:"GB",MAN:"GB",EDI:"GB",LAX:"US",SJC:"US",SFO:"US",SEA:"US",PDX:"US",SAN:"US",LAS:"US",PHX:"US",SLC:"US",DEN:"US",DFW:"US",IAH:"US",AUS:"US",ORD:"US",MSP:"US",DTW:"US",STL:"US",MCI:"US",ATL:"US",MIA:"US",MCO:"US",BNA:"US",CLT:"US",IAD:"US",BOS:"US",EWR:"US",JFK:"US",PHL:"US",YYZ:"CA",YVR:"CA",YUL:"CA",MEX:"MX",GRU:"BR",TPE:"TW",KHH:"TW",TSA:"TW",RMQ:"TW"};jn=4,Ee=8,Yn=3,Po=2,Ao=1,Co=30*1e3,_n=new Map});function Xn(t){let e=t.split(".");if(e.length!==4)return null;let r=0;for(let n of e){if(!/^\d{1,3}$/.test(n))return null;let a=Number(n);if(a>255)return null;r=r*256+a}return r>>>0}function ye(t){let e=Xn(t);if(e===null)return!1;for(let[r,n]of To){let a=Xn(r);if(a===null)continue;let i=n===0?0:4294967295<<32-n>>>0;if((e&i)===(a&i))return!0}return!1}function Bn(t){let e=[],r=new Set,n=l=>{let p=`${l.source}|${l.host}|${l.port}`;r.has(p)||(r.add(p),e.push(l))};for(let l of t.proxies??[])l.kind==="direct"?n({source:"proxy",host:l.host,port:l.port,label:`ProxyIP ${l.host}:${l.port}`,via:{kind:"direct",host:l.host,port:l.port}}):n({source:"proxy",host:l.host,port:l.port,label:`${l.kind.toUpperCase()} ${l.host}:${l.port}`,via:{kind:l.kind,host:l.host,port:l.port,username:l.username,password:l.password,serverName:l.serverName}});let i=ye(t.targetHost)||t.deprioritizeDirect===!0;n({source:"direct",host:t.targetHost,port:t.targetPort,label:`\u76F4\u8FDE ${t.targetHost}:${t.targetPort}`,deprioritized:i});let s=t.optimizedIps??[],d=s.filter(l=>!ye(l.ip)),c=s.filter(l=>ye(l.ip));for(let l of d)n({source:"optimized",host:l.ip,port:l.port,label:`\u4F18\u9009 ${l.ip}:${l.port}`});for(let l of c)n({source:"optimized",host:l.ip,port:l.port,label:`\u4F18\u9009 ${l.ip}:${l.port}\uFF08Cloudflare \u7F51\u6BB5\uFF0C\u53EF\u80FD\u4E0D\u53EF\u8FBE\uFF09`,deprioritized:!0});let u=t.relay??[];for(let l of u)n({source:"relay",host:l.ip,port:l.port,label:`\u53CD\u4EE3 ${l.label}`,deprioritized:!t.relayAsPrimary});return e.map((l,p)=>({candidate:l,index:p})).sort((l,p)=>{let f=+!!l.candidate.deprioritized-+!!p.candidate.deprioritized;return f!==0?f:l.index-p.index}).map(l=>l.candidate)}function Jn(t){let e=t.filter(r=>!r.deprioritized);return{proxy:e.filter(r=>r.source==="proxy"),direct:e.filter(r=>r.source!=="proxy"),fallback:t.filter(r=>r.deprioritized)}}function Qn(t,e){let r=t instanceof Error?t.message:String(t);return/proxy request failed|cannot connect to the specified address|TCP Loop/i.test(r)?{kind:"blocked",message:r,candidate:e}:/timeout|超时|timed out|abort/i.test(r)?{kind:"timeout",message:r,candidate:e}:{kind:"other",message:r,candidate:e}}function qn(t){switch(t.kind){case"blocked":return`\u51FA\u7AD9\u88AB Cloudflare \u62D2\u7EDD\uFF08${t.candidate}\uFF09\uFF1A${t.message}
  \u5E38\u89C1\u539F\u56E0\uFF1A\u76EE\u6807\u5730\u5740\u5728 Cloudflare \u81EA\u5BB6\u7F51\u6BB5\uFF08Worker \u4E0D\u80FD\u4E3B\u52A8\u8FDE\u56DE CF \u81EA\u5DF1\u7684\u5165\u53E3\uFF09\u3002
  \u2192 \u6362\u4E00\u4E2A\u7B2C\u4E09\u65B9 IP\uFF0C\u6216\u6539\u7528\u4EE3\u7406\u843D\u5730\u3002`;case"timeout":return`\u51FA\u7AD9\u8D85\u65F6\uFF08${t.candidate}\uFF09\uFF1A${t.message}
  \u2192 \u8BE5\u5730\u5740\u5F53\u524D\u4E0D\u53EF\u8FBE\uFF0C\u53EF\u6362\u4E00\u6761\u5019\u9009\u6216\u542F\u7528\u4EE3\u7406\u843D\u5730\u3002`;default:return`\u51FA\u7AD9\u5931\u8D25\uFF08${t.candidate}\uFF09\uFF1A${t.message}`}}var To,Jt=F(()=>{"use strict";To=[["104.16.0.0",13],["104.24.0.0",14],["104.31.0.0",15],["172.64.0.0",13],["162.158.0.0",15],["188.114.96.0",20],["141.101.64.0",18],["108.162.192.0",18],["103.21.244.0",22],["103.22.200.0",22],["103.31.4.0",22],["131.0.72.0",22],["197.234.240.0",22],["198.41.128.0",17],["192.0.0.0",24],["192.0.2.0",24],["192.88.99.0",24],["199.27.128.0",21],["223.5.5.0",24],["1.0.0.0",24],["1.1.1.0",24]]});function Kn(t,e="direct"){let r=t.trim();if(!r)return null;let n=e,a=r,i=/^([a-z0-9+.-]+):\/\//i.exec(r);if(i){let m=i[1].toLowerCase();a=r.slice(i[0].length),m==="socks5"||m==="socks"||m==="socks5h"?n="socks5":m==="https"?n="https":m==="http"&&(n="http")}let s=a.lastIndexOf("@"),d={};if(s>=0){let m=a.slice(0,s);a=a.slice(s+1);let b=m.indexOf(":");b>=0?d={username:m.slice(0,b),password:m.slice(b+1)}:d={username:m}}let c,u=/#sni=([^/#]+)/i.exec(a);u&&(c=u[1].trim(),a=a.slice(0,u.index)+a.slice(u.index+u[0].length));let l=a.lastIndexOf(":");if(l<0)return null;let p=a.slice(0,l).replace(/^\[|\]$/g,""),f=Number(a.slice(l+1));return!p||!Number.isInteger(f)||f<=0||f>65535?null:(!c&&n==="https"&&!Uo(p)&&(c=p),{host:p,port:f,kind:n,...d,...c?{serverName:c}:{}})}function Uo(t){return/^\d{1,3}(\.\d{1,3}){3}$/.test(t)}function Re(t,e="direct"){let r=[];for(let n of t.split(/[\n,;]+/)){let a=n.trim();if(!a)continue;let i=Kn(a,e);i&&r.push(i)}return r}var Qt=F(()=>{"use strict"});async function Eo(){return qt||(qt=(async()=>(await import("cloudflare"+":sockets")).connect)()),await qt}function Mo(t,e){if(!Z(t))return null;let r=t.split(".").map(s=>Number(s)),n=(r[0]<<8|r[1]).toString(16),a=(r[2]<<8|r[3]).toString(16);return`${e.replace(/:+$/,"")}::${n}:${a}`}async function at(t,e,r,n,a){let s=(await Eo())({hostname:t,port:e},n?{secureTransport:n}:void 0),d=async(u,l)=>{let p,f=new Promise((m,b)=>{p=setTimeout(()=>b(new Error(`${l}\u8D85\u65F6\uFF1A${t}:${e}`)),r)});try{return await Promise.race([u,f])}finally{p&&clearTimeout(p)}},c;try{if(await d(s.opened,"\u8FDE\u63A5"),n==="starttls"){if(c=s.startTls?.(a?{expectedServerHostname:a}:void 0),!c)throw new Error("\u5F53\u524D\u8FD0\u884C\u65F6\u4E0D\u652F\u6301 startTls");return await d(c.opened,"TLS \u63E1\u624B"),c}return s}catch(u){try{await(c??s).close()}catch{}throw u}}async function Do(t){let e=t.timeoutMs??er;try{let r=await at(t.hostname,t.port,e);return{readable:r.readable,writable:r.writable,via:"direct",endpoint:`${t.hostname}:${t.port}`}}catch(r){if(t.nat64&&Z(t.hostname)){let n=Mo(t.hostname,t.nat64);if(n){let a=await at(n,t.port,e);return{readable:a.readable,writable:a.writable,via:"nat64",endpoint:`${n}:${t.port}`}}}throw r}}async function No(t,e){let r=t.timeoutMs??er;if(e.kind==="direct"){let i=await at(e.host,e.port,r);return{readable:i.readable,writable:i.writable,via:"direct",endpoint:`${e.host}:${e.port}`}}let n=e.kind==="https"?"starttls":void 0,a=await at(e.host,e.port,r,n,e.kind==="https"?e.serverName:void 0);try{return e.kind==="http"||e.kind==="https"?{readable:await Fn(a.readable,a.writable,t.hostname,t.port,{username:e.username,password:e.password}),writable:a.writable,via:e.kind,endpoint:`${e.host}:${e.port}`}:{readable:await $n(a.readable,a.writable,t.hostname,t.port,{username:e.username,password:e.password}),writable:a.writable,via:"socks5",endpoint:`${e.host}:${e.port}`}}catch(i){try{await a.close()}catch{}throw i}}async function Kt(t,e){if(t.length===0)throw new Error("\u6CA1\u6709\u53EF\u7528\u7684\u51FA\u7AD9\u62E8\u53F7\u65B9\u5F0F");if(t.length===1||!e){let r=new Error("\u62E8\u53F7\u5931\u8D25");for(let n of t)try{return await n()}catch(a){r=a}throw r}return await new Promise((r,n)=>{let a=t.length,i=!1,s=[];for(let d of t)d().then(c=>{if(i){try{c.writable.getWriter().close()}catch{}return}i=!0,r(c)},c=>{s.push(c),a-=1,a===0&&!i&&(i=!0,n(s[0]??new Error("\u62E8\u53F7\u5931\u8D25")))})})}async function ea(t,e){let r=[...t];if(!e)return r;try{let n=await nt(e),a=new Set(r.map(i=>`${i.ip}:${i.port}`));for(let i of n){let s=`${i.ip}:${i.port}`;a.has(s)||(a.add(s),r.push(i))}}catch{}return r}async function Vo(t,e,r){if(t.length===0)return null;for(let n=0;n<t.length;n+=Ee){let i=t.slice(n,n+Ee).map(s=>e({source:"relay",host:s.ip,port:s.port,label:`\u53CD\u4EE3 ${s.label}`}));try{return await Kt(i,r)}catch{}}return null}async function Me(t){let e=t.proxies??[],r=t.concurrent??!0,n=t.budgetMs??Ro,a=Date.now()+n,i=[...t.optimizedIps??[]],s=!1;if(t.resolvePreferred)try{let w=await tt(t.hostname,t.port,{deadline:a});if(w.length>0){s=!0;for(let U of w)i.push({ip:U.hostname,port:U.port})}}catch{}let d=ye(t.hostname),c=s&&i.length>0&&i.every(w=>ye(w.ip)),u=[...t.relay??[]],l=c||d;l&&t.relayPool&&(u=await ea(u,{...t.relayPool,deadline:a}));let p=l?u.slice(0,Ee):[],f=l?u.slice(Ee):[],m=Bn({targetHost:t.hostname,targetPort:t.port,optimizedIps:i,proxies:e,deprioritizeDirect:d||c,relay:p,relayAsPrimary:p.length>0});if(m.length===0)throw new Error("\u6CA1\u6709\u53EF\u7528\u7684\u51FA\u7AD9\u62E8\u53F7\u65B9\u5F0F");let b=w=>async()=>{let U=a-Date.now();if(U<=0)throw new Error(`\u62E8\u53F7\u9884\u7B97\u5DF2\u7528\u5C3D\uFF08${n}ms\uFF09\uFF1A${t.hostname}:${t.port}`);let T=Math.max(200,Math.min(t.timeoutMs??er,U)),y={...t,timeoutMs:T};try{return w.source==="proxy"&&w.via?await No(y,{host:w.via.host,port:w.via.port,kind:w.via.kind,username:w.via.username,password:w.via.password,serverName:w.via.serverName}):await Do({...y,hostname:w.host,port:w.port})}catch(k){let E=Qn(k,w.label);throw t.onFailure?.(E),k}},v=Jn(m),{proxy:x,direct:h,fallback:g}=v;if(x.length>0){let w=x.map(b);try{return await Kt(w,r)}catch(U){if(g.length===0)throw U;for(let T of g)try{return await b(T)()}catch{}throw U}}let A=h.map(b);try{return await Kt(A,r)}catch(w){let U=f;U.length===0&&t.relayPool&&(U=await ea([],{...t.relayPool,deadline:a}));let T=await Vo(U,b,r);if(T)return T;if(g.length===0)throw w;for(let y of g)try{return await b(y)()}catch{}throw w}}var qt,er,Ro,tr=F(()=>{"use strict";On();Hn();se();Xt();Bt();Jt();Qt();qt=null;er=8e3,Ro=15e3});var ia={};st(ia,{handleWebSocket:()=>rr,recentDiagnostics:()=>Oo,recordDiagnostics:()=>De,truncateCloseReason:()=>oa});function oa(t,e=123){let r=new TextEncoder;if(r.encode(t).length<=e)return t;let n=t.slice(0,e);for(;r.encode(n).length>e;)n=n.slice(0,-1);n=n.replace(/\uFFFD+$/,"");let a="\u2026";for(;n.length>0&&r.encode(n+a).length>e;)n=n.slice(0,-1);return n+a}function De(t,e,r){ot.unshift({at:Date.now(),target:t,failures:e,summary:r}),ot.length>aa&&(ot.length=aa)}function Oo(){return ot}async function rr(t,e,r,n,a,i){let[s,d]=Object.values(new WebSocketPair);try{d.accept({allowHalfOpen:!0})}catch{d.accept()}d.binaryType="arraybuffer";let c=new Uint8Array(0),u=!1,l=null,p=null,f=null,m=null,b=P=>{try{d.send(P)}catch{}},v=P=>{let I=new Uint8Array(2+P.byteLength);I[0]=0,I[1]=P.byteLength,I.set(P,2),b(I)},x=(P,I)=>{try{d.close(P,oa(I))}catch{}},h=()=>{if(f&&(clearTimeout(f),f=null),g&&(clearTimeout(g),g=null),l)try{l.writable.close()}catch{}},g=null,A=new Set,w=0,U=async()=>{if(!l)return;let P=l.readable.getReader();g&&clearTimeout(g),g=setTimeout(()=>{g=null,!(T>0)&&(De(`${m.hostname}:${m.port}`,[],`\u76F4\u8FDE ${ra}ms \u65E0\u4E0B\u884C\u6570\u636E\uFF0C\u6539\u8D70\u53CD\u4EE3\u5165\u53E3`),C())},ra);try{for(;;){let{done:I,value:R}=await P.read();if(I)break;R&&R.byteLength>0&&(T+=R.byteLength,b(R))}}catch{}finally{try{P.releaseLock()}catch{}g&&(clearTimeout(g),g=null),x(1e3,"done")}},T=0,y=async P=>{if(p)try{await p.write(P)}catch{h()}},k=P=>{if(e==="vless"){let R=En(P,r.uuid);return R?{command:R.header.command,port:R.header.port,hostname:R.header.hostname,headerLength:R.consumed}:null}let I=Vn(P,r.trojanPassword);return I?{command:I.header.command,port:I.header.port,hostname:I.header.hostname,headerLength:I.consumed}:null},E=async P=>{let I=k(c);if(!I){P||(f=setTimeout(()=>{f=null,E(!0).catch(M=>x(1011,String(M)))},Fo));return}if(f&&(clearTimeout(f),f=null),u)return;u=!0,m=I;let R=e==="vless"?In:Nn;if(I.command===R){x(1002,"UDP over WebSocket \u6682\u4E0D\u652F\u6301");return}v(new Uint8Array(0));let N=[],V=null;try{l=await Me({hostname:I.hostname,port:I.port,proxies:n,timeoutMs:ta,concurrent:r.concurrentDial,nat64:r.nat64||void 0,resolvePreferred:r.resolvePreferred,relayPool:{userEntries:r.relayPool||void 0,useBuiltin:r.useBuiltinRelay,colo:typeof t.cf?.colo=="string"?t.cf.colo:void 0},onFailure:M=>{N.push(M),i?.failures.push(M)}})}catch(M){V=M}if(!l){let M=N.length>0?N.map(D=>qn(D)).join(`
`):`\u51FA\u7AD9\u8FDE\u63A5\u5931\u8D25\uFF1A${String(V)}`;De(`${I.hostname}:${I.port}`,N,M),x(1011,M);return}p=l.writable.getWriter();let $=c.byteLength>I.headerLength?c.slice(I.headerLength):new Uint8Array(0);$.byteLength>0&&await y($),c=new Uint8Array(0),a?.waitUntil(U())},C=async()=>{let P=m;if(!P){x(1011,"\u51FA\u7AD9\u65E0\u6570\u636E\uFF1A\u76EE\u6807\u672A\u89E3\u6790");return}if(w>=na){x(1011,"\u51FA\u7AD9\u65E0\u6570\u636E\uFF1A\u76F4\u8FDE\u4E0E\u53CD\u4EE3\u5165\u53E3\u5747\u65E0\u54CD\u5E94");return}w++;let I=[];try{I=await nt({userEntries:r.relayPool||void 0,useBuiltin:r.useBuiltinRelay,colo:typeof t.cf?.colo=="string"?t.cf.colo:void 0})}catch{I=[]}let R=I.filter(N=>!A.has(`${N.ip}:${N.port}`));if(R.length===0){x(1011,"\u51FA\u7AD9\u65E0\u6570\u636E\uFF1A\u65E0\u53CD\u4EE3\u5165\u53E3\u53EF\u7528");return}for(let N of R.slice(0,na)){if(A.add(`${N.ip}:${N.port}`),l)try{l.writable.close()}catch{}p=null,T=0;try{let V=await Me({hostname:N.ip,port:N.port,timeoutMs:ta,resolvePreferred:!1});if(!V)continue;l=V,p=V.writable.getWriter(),c.byteLength>0&&(await p.write(c),c=new Uint8Array(0)),De(`${P.hostname}:${P.port}`,[],`\u5DF2\u5207\u6362\u53CD\u4EE3\u5165\u53E3 ${N.ip}:${N.port}`),a?.waitUntil(U());return}catch(V){De(`${P.hostname}:${P.port}`,[],`\u53CD\u4EE3\u5165\u53E3 ${N.ip}:${N.port} \u5931\u8D25\uFF1A${String(V)}`)}}x(1011,"\u51FA\u7AD9\u65E0\u6570\u636E\uFF1A\u6240\u6709\u53CD\u4EE3\u5165\u53E3\u5747\u5931\u8D25")};d.addEventListener("message",P=>{(async()=>{let I=P.data,R=typeof I=="string"?new TextEncoder().encode(I):new Uint8Array(I);if(R.byteLength!==0){if(!u){if(c=Zt(c,R),c.byteLength>Lo){x(1009,"\u63E1\u624B\u5934\u8D85\u8FC7 64KB");return}await E(!1);return}if(!p){if(c=Zt(c,R),c.byteLength>$o){x(1009,"\u62E8\u53F7\u671F\u95F4\u6570\u636E\u8FC7\u591A");return}return}await y(R)}})()});let S=()=>{h()};d.addEventListener("close",S),d.addEventListener("error",S);try{return new Response(null,{status:101,webSocket:s})}catch(P){return console.error("[\u81EA\u7814\u6570\u636E\u9762] 101 \u54CD\u5E94\u6784\u9020\u5931\u8D25\uFF1A",P),new Response(null,{status:200})}}var ta,ra,na,Lo,$o,ot,aa,Fo,nr=F(()=>{"use strict";Gt();Ln();Ue();tr();Jt();Bt();ta=5e3,ra=2500,na=2,Lo=64*1024,$o=8*1024*1024;ot=[],aa=20;Fo=80});var la={};st(la,{handleXhttp:()=>ir,recentXhttpDiagnostics:()=>Ho,recordXhttpDiagnostics:()=>sa});function sa(t,e,r){it.unshift({at:Date.now(),target:t,...e,summary:r}),it.length>20&&(it.length=20)}function Ho(){return it}async function ir(t,e,r){let n=t.body;if(!n)return new Response("\u7F3A\u5C11\u8BF7\u6C42\u4F53",{status:400});let a=new ce(n),i=await Un(a,e.uuid);if(!i)return new Response("VLESS \u5934\u89E3\u6790\u5931\u8D25",{status:400});if(i.header.command!==Cn)return new Response("XHTTP \u6682\u4E0D\u652F\u6301 UDP",{status:400});let s=await Me({hostname:i.header.hostname,port:i.header.port,proxies:r,nat64:e.nat64,concurrent:e.concurrentDial,resolvePreferred:e.resolvePreferred,relayPool:{userEntries:e.relayPool||void 0,useBuiltin:e.useBuiltinRelay},onFailure:b=>{sa(`${i.header.hostname}:${i.header.port}`,b,`XHTTP \u51FA\u7AD9\u5931\u8D25\uFF08${b.candidate}\uFF09\uFF1A${b.message}`)}}),{readable:d,writable:c}=new TransformStream;Lt(i.payload,s.writable,void 0,!1),Lt(s.readable,c);let u=i.header.addons;if(u.byteLength>255)return new Response("Addons \u957F\u5EA6\u8D85\u51FA VLESS \u534F\u8BAE\u4E0A\u9650",{status:400});let l=new Uint8Array(2+u.byteLength);l[0]=i.header.version,l[1]=u.byteLength,l.set(u,2);let p=!1,f=null,m=new ReadableStream({start(b){b.enqueue(l),p=!0},async pull(b){if(p){f||(f=d.getReader());try{let{done:v,value:x}=await f.read();if(v){b.close();return}x&&x.byteLength>0&&b.enqueue(x)}catch{try{b.close()}catch{}}}},cancel(b){d.cancel(b)}});return new Response(m,{status:200,headers:{"Content-Type":"text/event-stream","Cache-Control":"no-store","X-Accel-Buffering":"no"}})}var it,sr=F(()=>{"use strict";Ue();Gt();$t();tr();it=[]});ke();Ct();ge();var $a=15*1024*1024,Oa=2*1024*1024;async function Ge(t){let e=new URL(t.url);if(t.headers.get("Upgrade")?.toLowerCase()==="websocket"){let c=new WebSocketPair,[u,l]=Object.values(c);return l.accept(),l.addEventListener("message",p=>{let f=typeof p.data=="string"?p.data:"";if(f==="PING"||f==="ping"){l.send(JSON.stringify({pong:!0,colo:t.cf?.colo??"UNK",clientIp:t.headers.get("CF-Connecting-IP")??""}));try{l.close(1e3,"Probe complete")}catch{}}}),new Response(null,{status:101,webSocket:u})}let n=Number.parseInt(e.searchParams.get("bytes")??"",10),a=Number.isFinite(n)&&n>0?Math.min(n,$a):Oa,i=new Uint8Array(64*1024);for(let c=0;c<i.length;c++)i[c]=97;let s=0,d=new ReadableStream({pull(c){if(s>=a){c.close();return}let u=Math.min(i.byteLength,a-s);c.enqueue(i.subarray(0,u)),s+=u}});return new Response(d,{status:200,headers:{"Content-Type":"application/octet-stream","Cache-Control":"no-store","Access-Control-Allow-Origin":"*","X-Probe-Bytes":String(a),"X-Probe-Nonce":ee(4)}})}var Vr="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";var Ze=null;function Fa(t){let e=atob(t),r=new Uint8Array(new ArrayBuffer(e.length));for(let n=0;n<e.length;n++)r[n]=e.charCodeAt(n);return r}async function Lr(){if(Ze!==null)return Ze;let t=Fa(Vr),e=new Response(t).body;if(!e)throw new Error("\u9762\u677F\u6570\u636E\u635F\u574F");let r=e.pipeThrough(new DecompressionStream("gzip"));return Ze=await new Response(r).text(),Ze}function It(t){let e=t===200?"Welcome":t===404?"Not Found":"Service Unavailable",r=`<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${e}</title><style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f7f8fa;color:#333;font-family:-apple-system,"Segoe UI","PingFang SC",sans-serif}.c{text-align:center}h1{font-size:22px;font-weight:600;margin:0 0 10px}p{color:#888;font-size:14px;margin:0}</style></head><body><div class="c"><h1>${e}</h1><p>This site is up and running.</p></div></body></html>`;return new Response(r,{status:t,headers:{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}})}function ve(t,e){return new Response(JSON.stringify({ok:!1,error:t}),{status:e,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"}})}Xe();Xe();var Ft=null;async function ja(){return Ft||(Ft=await Promise.resolve().then(()=>(Kr(),qr))),Ft}async function Ya(t,e,r,n){let a=await Ye(r,n),i=e.pathname.slice(5).split("/")[0]??"";if(!(i===a.uuid||i===a.trojanPassword||e.searchParams.get("token")===a.uuid))return ve("\u8BA2\u9605\u4EE4\u724C\u65E0\u6548",403);let d=e.searchParams.get("target")??e.searchParams.get("format"),c=d?Vt(d):Qr(t.headers.get("User-Agent"))??Vt(null),u=await r.get(be)??"",l=await _e(a,u),p=Ie(a.subDomain||n.DATA_HOST||e.hostname),f={nodes:l.nodes,groups:l.groups,config:a,domain:p,port:443,ports:Mr(a),protocol:a.subProtocol,transport:a.subTransport},m=Nr(c,f);return new Response(m.body,{status:200,headers:{"Content-Type":m.contentType,"Cache-Control":"no-store","Content-Disposition":`inline; filename="${m.fileName}"`,"Profile-Title":Pt(a.subName),"Subscription-Userinfo":""}})}async function en(t,e){let r=new URL(t.url),n=Dt(e);if(t.method==="OPTIONS")return new Response(null,{status:204,headers:{"Access-Control-Allow-Origin":"*","Access-Control-Allow-Methods":"GET, POST, PUT, DELETE, OPTIONS","Access-Control-Allow-Headers":"Content-Type, Authorization","Access-Control-Max-Age":"86400"}});if(r.pathname==="/__edge_probe")return Ge(t);if(r.pathname.startsWith("/api/")){let{handleApi:i}=await ja(),s=await i(t,r,{store:n,env:e,config:await Ye(n,e),auth:await Nt(n,e),onConfigChanged:Jr});if(s)return s}if(r.pathname==="/sub"||r.pathname.startsWith("/sub/"))return await Ya(t,r,n,e);let a=await Nt(n,e);return r.pathname===a.panelPath||r.pathname===`${a.panelPath}/`?new Response(await Lr(),{status:200,headers:{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store","X-Content-Type-Options":"nosniff","Referrer-Policy":"no-referrer"}}):null}async function tn(t){let e=Dt(t);return await Ye(e,t)}import{connect as Xa}from"cloudflare:sockets";var o=atob,Ba=new RegExp("^("+o("c29ja3M1")+"|http|https|ss):\\/\\/(.+)$","i"),Ti=new RegExp(o("Y2xhc2g=")+"|"+o("c2luZ2JveA==")+"|"+o("c2luZy1ib3g=")+"|"+o("c3VyZ2U=")+"|"+o("c3VyZmJvYXJk")+"|"+o("bG9vbg==")+"|"+o("cXVhbnR1bXVsdA==")),Ui=new RegExp(o("a2FyaW5n"),"i"),Ei=new RegExp("(?:"+o("dmxlc3M=")+"|"+o("dHJvamFu")+"):\\/\\/[^@\\s/]+@(\\[[0-9a-fA-F:]+\\]|[A-Za-z0-9.-]+)(?::(\\d{1,5}))?"),Ri=new RegExp("^"+o("dmxlc3M=")+":\\/\\/");var rn="CFNext";var Mi=o("UEFJQ05J")+"/"+o("Q0ZOZXh0");var z="application/octet-stream",Je="text/yaml; charset=utf-8",Di={Tracking:{url:"https://github.com/"+o("NjY2T1M=")+"/rules/raw/release/"+o("bWlob21v")+"/domain/Tracking.mrs",ct:z},Advertising:{url:"https://github.com/"+o("NjY2T1M=")+"/rules/raw/release/"+o("bWlob21v")+"/domain/Advertising.mrs",ct:z},AWAvenueAds:{url:"https://raw.githubusercontent.com/"+o("VEctVHdpbGlnaHQ=")+"/"+o("QVdBdmVudWU=")+"-Ads-Rule/main/Filters/"+o("QVdBdmVudWU=")+"-Ads-Rule-"+o("Q2xhc2g=")+".yaml",ct:Je},Direct:{url:"https://github.com/"+o("NjY2T1M=")+"/rules/raw/release/"+o("bWlob21v")+"/domain/Direct.mrs",ct:z},Private:{url:"https://github.com/"+o("NjY2T1M=")+"/rules/raw/release/"+o("bWlob21v")+"/domain/Private.mrs",ct:z},Download:{url:"https://github.com/"+o("NjY2T1M=")+"/rules/raw/release/"+o("bWlob21v")+"/domain/Download.mrs",ct:z},AppleCN:{url:"https://github.com/"+o("NjY2T1M=")+"/rules/raw/release/"+o("bWlob21v")+"/domain/AppleCN.mrs",ct:z},China:{url:"https://cdn.jsdelivr.net/gh/"+o("YmxhY2ttYXRyaXg3")+"/"+o("aW9zX3J1bGVfc2NyaXB0")+"@master/rule/"+o("Q2xhc2g=")+"/ChinaMaxNoIP/ChinaMaxNoIP_No_Resolve.yaml",ct:Je},AI:{url:"https://github.com/"+o("NjY2T1M=")+"/rules/raw/release/"+o("bWlob21v")+"/domain/AI.mrs",ct:z},Telegram:{url:"https://github.com/"+o("NjY2T1M=")+"/rules/raw/release/"+o("bWlob21v")+"/domain/Telegram.mrs",ct:z},Twitter:{url:"https://github.com/"+o("NjY2T1M=")+"/rules/raw/release/"+o("bWlob21v")+"/domain/Twitter.mrs",ct:z},SocialMedia:{url:"https://github.com/"+o("NjY2T1M=")+"/rules/raw/release/"+o("bWlob21v")+"/domain/SocialMedia.mrs",ct:z},Netflix:{url:"https://github.com/"+o("NjY2T1M=")+"/rules/raw/release/"+o("bWlob21v")+"/domain/Netflix.mrs",ct:z},[o("WW91VHViZQ==")]:{url:"https://github.com/"+o("NjY2T1M=")+"/rules/raw/release/"+o("bWlob21v")+"/domain/"+o("WW91VHViZQ==")+".mrs",ct:z},Google:{url:"https://github.com/"+o("NjY2T1M=")+"/rules/raw/release/"+o("bWlob21v")+"/domain/Google.mrs",ct:z},Microsoft:{url:"https://cdn.jsdelivr.net/gh/"+o("YmxhY2ttYXRyaXg3")+"/"+o("aW9zX3J1bGVfc2NyaXB0")+"@master/rule/"+o("Q2xhc2g=")+"/Microsoft/Microsoft.yaml",ct:Je},Proxy:{url:"https://github.com/"+o("NjY2T1M=")+"/rules/raw/release/"+o("bWlob21v")+"/domain/Proxy.mrs",ct:z},Spotify:{url:"https://github.com/"+o("RHVzdGluV2lu")+"/"+o("cnVsZXNldF9nZW9kYXRh")+"/releases/download/"+o("bWlob21v")+"-ruleset/spotify.mrs",ct:z},TikTok:{url:"https://github.com/"+o("RHVzdGluV2lu")+"/"+o("cnVsZXNldF9nZW9kYXRh")+"/releases/download/"+o("bWlob21v")+"-ruleset/tiktok.mrs",ct:z},disney:{url:"https://github.com/"+o("RHVzdGluV2lu")+"/"+o("cnVsZXNldF9nZW9kYXRh")+"/releases/download/"+o("bWlob21v")+"-ruleset/disney.mrs",ct:z},github:{url:"https://rule.kelee.one/"+o("Q2xhc2g=")+"/GitHub.yaml",ct:Je},PrivateIP:{url:"https://github.com/"+o("NjY2T1M=")+"/rules/raw/release/"+o("bWlob21v")+"/ip/Private.mrs",ct:z},TelegramIP:{url:"https://github.com/"+o("NjY2T1M=")+"/rules/raw/release/"+o("bWlob21v")+"/ip/Telegram.mrs",ct:z},[o("UHJveHlJUA==")]:{url:"https://github.com/"+o("NjY2T1M=")+"/rules/raw/release/"+o("bWlob21v")+"/ip/Proxy.mrs",ct:z},ChinaIP:{url:"https://github.com/"+o("NjY2T1M=")+"/rules/raw/release/"+o("bWlob21v")+"/ip/China.mrs",ct:z}};var Ja=["173.245.48.0/20","103.21.244.0/22","103.22.200.0/22","103.31.4.0/22","141.101.64.0/18","108.162.192.0/18","190.93.240.0/20","188.114.96.0/20","197.234.240.0/22","198.41.128.0/17","162.158.0.0/15","104.16.0.0/13","104.24.0.0/14","172.64.0.0/13","131.0.72.0/22"];var yn=["2400:cb00::/32","2606:4700::/32","2803:f800::/32","2405:b500::/32","2405:8100::/32","2a06:98c0::/29","2c0f:f248::/32"];var Ni=yn.slice();function Qa(t){if(!ue(t=String(t||"")))return!1;if(t.indexOf(":")>=0)return yn.some(n=>(function(a,i){let[s,d]=i.split("/"),c=parseInt(d,10),u=p=>{let f=p.indexOf("::"),m;if(f>=0){let b=p.slice(0,f).split(":").filter(Boolean),v=p.slice(f+2).split(":").filter(Boolean),x=8-b.length-v.length;m=[...b,...Array(x).fill("0"),...v]}else m=p.split(":");return m.map(b=>b.padStart(4,"0"))},l=p=>p.map(f=>parseInt(f,16).toString(2).padStart(16,"0")).join("");return l(u(a)).slice(0,c)===l(u(s)).slice(0,c)})(t,n));let e=t.split(".").map(Number),r=(e[0]<<24|e[1]<<16|e[2]<<8|e[3])>>>0;return eo.some(([n,a])=>r>=n&&r<=a)}var zt={HK:"\u9999\u6E2F",TW:"\u53F0\u6E7E",MO:"\u6FB3\u95E8",JP:"\u65E5\u672C",SG:"\u65B0\u52A0\u5761",US:"\u7F8E\u56FD",KR:"\u97E9\u56FD",DE:"\u5FB7\u56FD",FR:"\u6CD5\u56FD",GB:"\u82F1\u56FD",CA:"\u52A0\u62FF\u5927",AU:"\u6FB3\u5927\u5229\u4E9A",SE:"\u745E\u5178",NL:"\u8377\u5170",FI:"\u82AC\u5170",NO:"\u632A\u5A01",DK:"\u4E39\u9EA6",CH:"\u745E\u58EB",IT:"\u610F\u5927\u5229",ES:"\u897F\u73ED\u7259",PT:"\u8461\u8404\u7259",IE:"\u7231\u5C14\u5170",BE:"\u6BD4\u5229\u65F6",AT:"\u5965\u5730\u5229",PL:"\u6CE2\u5170",CZ:"\u6377\u514B",RO:"\u7F57\u9A6C\u5C3C\u4E9A",HU:"\u5308\u7259\u5229",GR:"\u5E0C\u814A",RU:"\u4FC4\u7F57\u65AF",TR:"\u571F\u8033\u5176",UA:"\u4E4C\u514B\u5170",IN:"\u5370\u5EA6",TH:"\u6CF0\u56FD",MY:"\u9A6C\u6765\u897F\u4E9A",VN:"\u8D8A\u5357",PH:"\u83F2\u5F8B\u5BBE",ID:"\u5370\u5C3C",BR:"\u5DF4\u897F",MX:"\u58A8\u897F\u54E5",AR:"\u963F\u6839\u5EF7",CL:"\u667A\u5229",ZA:"\u5357\u975E",EG:"\u57C3\u53CA",AE:"\u963F\u8054\u914B",IL:"\u4EE5\u8272\u5217",NZ:"\u65B0\u897F\u5170",KZ:"\u54C8\u8428\u514B\u65AF\u5766",SA:"\u6C99\u7279"},xn={};for(let t in zt)xn[zt[t]]=t;xn.\u5370\u5EA6\u5C3C\u897F\u4E9A="ID";var qa={HKG:"\u9999\u6E2F",TPE:"\u53F0\u6E7E",KHH:"\u53F0\u6E7E",TSA:"\u53F0\u6E7E",RMQ:"\u53F0\u6E7E",NRT:"\u65E5\u672C",KIX:"\u65E5\u672C",HND:"\u65E5\u672C",CTS:"\u65E5\u672C",FUK:"\u65E5\u672C",SIN:"\u65B0\u52A0\u5761",ICN:"\u97E9\u56FD",KUL:"\u9A6C\u6765\u897F\u4E9A",BKK:"\u6CF0\u56FD",MNL:"\u83F2\u5F8B\u5BBE",SGN:"\u8D8A\u5357",HAN:"\u8D8A\u5357",CGK:"\u5370\u5C3C",DEL:"\u5370\u5EA6",BOM:"\u5370\u5EA6",MAA:"\u5370\u5EA6",DXB:"\u963F\u8054\u914B",TLV:"\u4EE5\u8272\u5217",RUH:"\u6C99\u7279",JED:"\u6C99\u7279",DOH:"\u5361\u5854\u5C14",FRA:"\u5FB7\u56FD",MUC:"\u5FB7\u56FD",DUS:"\u5FB7\u56FD",HAM:"\u5FB7\u56FD",BER:"\u5FB7\u56FD",CGN:"\u5FB7\u56FD",STR:"\u5FB7\u56FD",AMS:"\u8377\u5170",CDG:"\u6CD5\u56FD",MRS:"\u6CD5\u56FD",NCE:"\u6CD5\u56FD",LHR:"\u82F1\u56FD",LGW:"\u82F1\u56FD",MAN:"\u82F1\u56FD",MAD:"\u897F\u73ED\u7259",BCN:"\u897F\u73ED\u7259",MXP:"\u610F\u5927\u5229",FCO:"\u610F\u5927\u5229",PMO:"\u610F\u5927\u5229",ZRH:"\u745E\u58EB",GVA:"\u745E\u58EB",VIE:"\u5965\u5730\u5229",WAW:"\u6CE2\u5170",PRG:"\u6377\u514B",ARN:"\u745E\u5178",CPH:"\u4E39\u9EA6",OSL:"\u632A\u5A01",HEL:"\u82AC\u5170",DUB:"\u7231\u5C14\u5170",LIS:"\u8461\u8404\u7259",BRU:"\u6BD4\u5229\u65F6",BUD:"\u5308\u7259\u5229",OTP:"\u7F57\u9A6C\u5C3C\u4E9A",ATH:"\u5E0C\u814A",IST:"\u571F\u8033\u5176",SVO:"\u4FC4\u7F57\u65AF",DME:"\u4FC4\u7F57\u65AF",LED:"\u4FC4\u7F57\u65AF",JFK:"\u7F8E\u56FD",EWR:"\u7F8E\u56FD",LAX:"\u7F8E\u56FD",SJC:"\u7F8E\u56FD",SFO:"\u7F8E\u56FD",SEA:"\u7F8E\u56FD",ORD:"\u7F8E\u56FD",DFW:"\u7F8E\u56FD",IAD:"\u7F8E\u56FD",ATL:"\u7F8E\u56FD",MIA:"\u7F8E\u56FD",BOS:"\u7F8E\u56FD",DEN:"\u7F8E\u56FD",PHX:"\u7F8E\u56FD",MSP:"\u7F8E\u56FD",DTW:"\u7F8E\u56FD",PHL:"\u7F8E\u56FD",CLT:"\u7F8E\u56FD",LAS:"\u7F8E\u56FD",PDX:"\u7F8E\u56FD",SLC:"\u7F8E\u56FD",SAN:"\u7F8E\u56FD",AUS:"\u7F8E\u56FD",IAH:"\u7F8E\u56FD",MCI:"\u7F8E\u56FD",BNA:"\u7F8E\u56FD",SMF:"\u7F8E\u56FD",RDU:"\u7F8E\u56FD",YYZ:"\u52A0\u62FF\u5927",YVR:"\u52A0\u62FF\u5927",YUL:"\u52A0\u62FF\u5927",YOW:"\u52A0\u62FF\u5927",YYC:"\u52A0\u62FF\u5927",MEX:"\u58A8\u897F\u54E5",GRU:"\u5DF4\u897F",GIG:"\u5DF4\u897F",EZE:"\u963F\u6839\u5EF7",SCL:"\u667A\u5229",SYD:"\u6FB3\u5927\u5229\u4E9A",MEL:"\u6FB3\u5927\u5229\u4E9A",BNE:"\u6FB3\u5927\u5229\u4E9A",PER:"\u6FB3\u5927\u5229\u4E9A",AKL:"\u65B0\u897F\u5170",JNB:"\u5357\u975E",CAI:"\u57C3\u53CA",ALA:"\u54C8\u8428\u514B\u65AF\u5766",ALB:"\u7F8E\u56FD",BDL:"\u7F8E\u56FD",BHM:"\u7F8E\u56FD",BIL:"\u7F8E\u56FD",BOI:"\u7F8E\u56FD",BUF:"\u7F8E\u56FD",BUR:"\u7F8E\u56FD",BTV:"\u7F8E\u56FD",BWI:"\u7F8E\u56FD",CAE:"\u7F8E\u56FD",CHA:"\u7F8E\u56FD",CLE:"\u7F8E\u56FD",CMH:"\u7F8E\u56FD",CPR:"\u7F8E\u56FD",DAL:"\u7F8E\u56FD",DAY:"\u7F8E\u56FD",DSM:"\u7F8E\u56FD",DTT:"\u7F8E\u56FD",ECP:"\u7F8E\u56FD",EYW:"\u7F8E\u56FD",FLL:"\u7F8E\u56FD",GRR:"\u7F8E\u56FD",GSP:"\u7F8E\u56FD",HIO:"\u7F8E\u56FD",HNL:"\u7F8E\u56FD",ICT:"\u7F8E\u56FD",IND:"\u7F8E\u56FD",JAX:"\u7F8E\u56FD",LBB:"\u7F8E\u56FD",MCO:"\u7F8E\u56FD",MDW:"\u7F8E\u56FD",MEM:"\u7F8E\u56FD",MFE:"\u7F8E\u56FD",MFR:"\u7F8E\u56FD",MSY:"\u7F8E\u56FD",OAK:"\u7F8E\u56FD",OKC:"\u7F8E\u56FD",OMA:"\u7F8E\u56FD",ONT:"\u7F8E\u56FD",ORF:"\u7F8E\u56FD",PIT:"\u7F8E\u56FD",PSC:"\u7F8E\u56FD",PVD:"\u7F8E\u56FD",RIC:"\u7F8E\u56FD",RNO:"\u7F8E\u56FD",RSW:"\u7F8E\u56FD",SAT:"\u7F8E\u56FD",SDF:"\u7F8E\u56FD",SNA:"\u7F8E\u56FD",STL:"\u7F8E\u56FD",SWF:"\u7F8E\u56FD",SYR:"\u7F8E\u56FD",TPA:"\u7F8E\u56FD",TUL:"\u7F8E\u56FD",TUS:"\u7F8E\u56FD",CTS:"\u65E5\u672C",FUK:"\u65E5\u672C",HND:"\u65E5\u672C",BLR:"\u5370\u5EA6",CMB:"\u65AF\u91CC\u5170\u5361",KWI:"\u79D1\u5A01\u7279",AMM:"\u7EA6\u65E6",BEY:"\u9ECE\u5DF4\u5AE9",NBO:"\u80AF\u5C3C\u4E9A",LOS:"\u5C3C\u65E5\u5229\u4E9A",ACC:"\u52A0\u7EB3",CPT:"\u5357\u975E",LIM:"\u79D8\u9C81",BOG:"\u54E5\u4F26\u6BD4\u4E9A",PTY:"\u5DF4\u62FF\u9A6C"},Vi=Object.assign({},zt,qa,{USA:"\u7F8E\u56FD"});var Li=["https://"+o("YmVzdGNm")+".pages.dev/random-region/HK/100.txt","https://"+o("YmVzdGNm")+".pages.dev/random-region/TW/100.txt","https://"+o("YmVzdGNm")+".pages.dev/random-region/JP/100.txt","https://"+o("YmVzdGNm")+".pages.dev/random-region/SG/100.txt","https://"+o("YmVzdGNm")+".pages.dev/random-region/US/100.txt","https://"+o("YmVzdGNm")+".pages.dev/random-region/KR/100.txt"].join(`
`);var $i={uuid:"",path:"",admin:"",login:"",adminInit:!1,host:"",enableVless:!0,enableTrojan:!1,trojanPassword:"",enableXhttp:!1,[o("YWxwbg==")]:"",ech:!1,echHost:"cloudflare-ech.com",echDns:"",tlsOnly:!1,nodeLimit:!0,nodeLimitCount:300,countryLabel:"",loadBalance:!0,ipv6Mode:"off",cpuLimit:!1,cfAccountId:"",cfApiToken:"",quotaAuto:!1,quotaStrict:!1,tgBotToken:"",tgChatID:"",homeWan:!1,homeWanNodes:[],[o("cHJveHlJUA==")]:"",outboundProxy:"",outboundMode:"",[o("d2FycEZyb250")]:"",mode:"",warpEnable:!1,warpConf:"",warpEps:"",warpName:"",masqueEnable:!1,masqueConf:"",masqueName:"",masqueNet:"",preferredDomains:"https://"+o("YmVzdGNm")+`.pages.dev/random-region/HK/100.txt
https://`+o("YmVzdGNm")+`.pages.dev/random-region/TW/100.txt
https://`+o("YmVzdGNm")+`.pages.dev/random-region/JP/100.txt
https://`+o("YmVzdGNm")+`.pages.dev/random-region/SG/100.txt
https://`+o("YmVzdGNm")+`.pages.dev/random-region/US/100.txt
https://`+o("YmVzdGNm")+".pages.dev/random-region/KR/100.txt",preferredIPs:[],optimizer:{source:"wetest_v4",sourceURL:"",fallbackPool:"",port:443,threads:5,count:20,useCidr:!0,fillCount:0,subMode:"",subRandomCount:16,subIncludeDefault:!1},filter:{region:"all",ipType:["IPv4"],isp:["\u79FB\u52A8","\u8054\u901A","\u7535\u4FE1"]}};var Oi=[{label:"\u9999\u6E2F",region:"HK",url:"https://"+o("YmVzdGNm")+".pages.dev/random-region/HK/100.txt",count:12},{label:"\u65E5\u672C",region:"JP",url:"https://"+o("YmVzdGNm")+".pages.dev/random-region/JP/100.txt",count:12},{label:"\u7F8E\u56FD",region:"US",url:"https://"+o("YmVzdGNm")+".pages.dev/random-region/US/100.txt",count:12},{label:"\u65B0\u52A0\u5761",region:"SG",url:"https://"+o("YmVzdGNm")+".pages.dev/random-region/SG/100.txt",count:12},{label:"\u53F0\u6E7E",region:"TW",url:"https://"+o("YmVzdGNm")+".pages.dev/random-region/TW/100.txt",count:12}];var Fi=["cloudflare.182682.xyz","speed.marisalnc.com","freeyx.cloudflare88.eu.org",o("YmVzdGNm")+".top","cdn.2020111.xyz","cfip.cfcdn.vip","cf.0sm.com","cf."+o("MDkwMjI3")+".xyz","cf.zhetengsha.eu.org","cloudflare.9jy.cc","cf.zerone-cdn.pp.ua","cfip.1323123.xyz","cnamefuckxxs.yuchen.icu","cloudflare-ip.mofashi.ltd","115155.xyz","cname.xirancdn.us","f3058171cad.002404.xyz","8.889288.xyz","cdn.tzpro.xyz","cf.877771.xyz","xn--b6gac.eu.org",o("YmVzdGNm")+"."+o("MDMwMTAx")+".xyz","cdns.doon.eu.org","fn.130519.xyz","saas.sin.fan"].join(`
`);var Hi={wetest_v4:{label:"\u5FAE\u6D4B\u7F51 IPv4",url:"https://www.wetest.vip/page/cloudflare/address_v4.html"},wetest_v6:{label:"\u5FAE\u6D4B\u7F51 IPv6",url:"https://www.wetest.vip/page/cloudflare/address_v6.html"},[o("YmVzdGNm")]:{label:"\u4F18\u9009 IP \u5217\u8868",url:"https://cf."+o("MDkwMjI3")+".xyz/ip.164746.xyz"},hostmonit:{label:"HostMonit \u4F18\u9009",url:"https://stock.hostmonit.com/CloudFlareYes"},wetest_cname:{label:"\u5FAE\u6D4B\u7F51 \u4F18\u9009\u57DF\u540D",url:"https://www.wetest.vip/page/cloudflare/cname.html"}},oe=new TextEncoder,le=new TextDecoder;function pe(t,e){return(t<<e|t>>>32-e)>>>0}function Te(t,e=443){if(!(t=String(t||"").trim()))return{host:"",port:e};if(t.startsWith("[")){let n=t.match(/^\[([^\]]+)\](?::(\d+))?$/);return{host:n?n[1]:t.replace(/^\[|\]$/g,""),port:n&&n[2]?parseInt(n[2]):e}}let r=t.lastIndexOf(":");return r>0&&/^\d+$/.test(t.slice(r+1))?{host:t.slice(0,r),port:parseInt(t.slice(r+1))}:{host:t,port:e}}function ue(t){if(!(t=String(t||"").trim()))return!1;let e=t.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);if(e)return e.slice(1).every(a=>Number(a)<=255);if(!/^[0-9a-fA-F:]+$/.test(t)||(t.match(/::/g)||[]).length>1)return!1;let r=t.includes("::"),n=t.replace(/::/g,":").split(":").filter(Boolean);return!(!r&&n.length!==8)&&(!r||!(n.length<1||n.length>7))&&n.every(a=>/^[0-9a-fA-F]{1,4}$/.test(a))}function wn(t){let e=[];for(let s=0;s<16;s+=2)e.push((t[s]<<8|t[s+1]).toString(16));let r=-1,n=0,a=-1,i=0;for(let s=0;s<8;s++)e[s]==="0"?(a<0?(a=s,i=1):i++,i>n&&(n=i,r=a)):(a=-1,i=0);if(n>=2){let s=e.slice(0,r).join(":");return(s?s+"::":"::")+e.slice(r+n).join(":")}return e.join(":")}function Ka(t){let[e,r]=t.split("/"),n=e.split(".").map(Number),a=(n[0]<<24|n[1]<<16|n[2]<<8|n[3])>>>0,i=r>=32?0:4294967295<<32-r>>>0;return[(a&i)>>>0,(a|~i>>>0)>>>0]}var eo=Ja.map(Ka);function nn(t){try{let e=atob(String(t).replace(/-/g,"+").replace(/_/g,"/")),r=new Uint8Array(e.length);for(let n=0;n<e.length;n++)r[n]=e.charCodeAt(n);return new TextDecoder("utf-8").decode(r)}catch{return null}}function to(t){if(!t||t.byteLength<1)throw new Error(o("VkxFU1M=")+" \u5934\u90E8\u8FC7\u77ED");let e=new DataView(t.buffer,t.byteOffset,t.byteLength),r=0;if(e.getUint8(0)!==0)throw new Error("\u4E0D\u652F\u6301\u7684 "+o("VkxFU1M=")+" \u7248\u672C");if(r+=17,r>=t.byteLength)throw new Error(o("VkxFU1M=")+" \u5934\u90E8\u8FC7\u77ED");let n=e.getUint8(r);if(r+=1,r+=n,r+3>t.byteLength)throw new Error(o("VkxFU1M=")+" \u5934\u90E8\u8FC7\u77ED");let a=e.getUint8(r);r+=1;let i=e.getUint16(r);r+=2;let s=e.getUint8(r);r+=1;let{addr:d,len:c}=(function(u,l,p,f){if(f===1)return{addr:`${l.getUint8(p)}.${l.getUint8(p+1)}.${l.getUint8(p+2)}.${l.getUint8(p+3)}`,len:4};if(f===2){let m=l.getUint8(p),b=u.subarray(p+1,p+1+m);return{addr:le.decode(b),len:1+m}}if(f===3)return{addr:wn(u.subarray(p,p+16)),len:16};throw new Error("\u65E0\u6CD5\u8BC6\u522B\u7684\u5730\u5740\u7C7B\u578B")})(t,e,r,s);return r+=c,{command:a,port:i,addr:d,headerLength:r,earlyData:t.subarray(r)}}var ro=[1116352408,1899447441,3049323471,3921009573,961987163,1508970993,2453635748,2870763221,3624381080,310598401,607225278,1426881987,1925078388,2162078206,2614888103,3248222580,3835390401,4022224774,264347078,604807628,770255983,1249150122,1555081692,1996064986,2554220882,2821834349,2952996808,3210313671,3336571891,3584528711,113926993,338241895,666307205,773529912,1294757372,1396182291,1695183700,1986661051,2177026350,2456956037,2730485921,2820302411,3259730800,3345764771,3516065817,3600352804,4094571909,275423344,430227734,506948616,659060556,883997877,958139571,1322822218,1537002063,1747873779,1955562222,2024104815,2227730452,2361852424,2428436474,2756734187,3204031479,3329325298],an="",on="";function sn(t){return t!==an&&(an=t,on=(function(e){let r=oe.encode(String(e)),n=8*r.length,a=1+(r.length+8>>6)<<6,i=new Uint8Array(a);i.set(r),i[r.length]=128;let s=new DataView(i.buffer);s.setUint32(a-8,Math.floor(n/4294967296),!1),s.setUint32(a-4,n>>>0,!1);let d=3238371032,c=914150663,u=812702999,l=4144912697,p=4290775857,f=1750603025,m=1694076839,b=3204075428,v=(h,g)=>h>>>g|h<<32-g;for(let h=0;h<a;h+=64){let g=new Uint32Array(64);for(let S=0;S<16;S++)g[S]=s.getUint32(h+4*S,!1);for(let S=16;S<64;S++){let P=v(g[S-15],7)^v(g[S-15],18)^g[S-15]>>>3,I=v(g[S-2],17)^v(g[S-2],19)^g[S-2]>>>10;g[S]=g[S-16]+P+g[S-7]+I>>>0}let A=d,w=c,U=u,T=l,y=p,k=f,E=m,C=b;for(let S=0;S<64;S++){let P=C+(v(y,6)^v(y,11)^v(y,25))+(y&k^~y&E)+ro[S]+g[S]>>>0,I=A&w^A&U^w&U;C=E,E=k,k=y,y=T+P>>>0,T=U,U=w,w=A,A=P+((v(A,2)^v(A,13)^v(A,22))+I>>>0)>>>0}d=d+A>>>0,c=c+w>>>0,u=u+U>>>0,l=l+T>>>0,p=p+y>>>0,f=f+k>>>0,m=m+E>>>0,b=b+C>>>0}let x="";for(let h of[d,c,u,l,p,f,m])x+=(h>>>24&255).toString(16).padStart(2,"0"),x+=(h>>>16&255).toString(16).padStart(2,"0"),x+=(h>>>8&255).toString(16).padStart(2,"0"),x+=(255&h).toString(16).padStart(2,"0");return x})(t)),on}var no=["https://doh.pub/dns-query","https://dns.alidns.com/resolve","https://1.1.1.1/dns-query","https://8.8.8.8/dns-query","https://dns.google/dns-query","https://cloudflare-dns.com/dns-query"];function ao(t){let e=String(t).split("::"),r=e[0]?e[0].split(":").filter(Boolean):[],n=e[1]?e[1].split(":").filter(Boolean):[],a=[...r,...Array(Math.max(0,8-r.length-n.length)).fill("0"),...n],i=new Uint8Array(16);return a.forEach((s,d)=>{let c=parseInt(s,16)||0;i[2*d]=c>>8&255,i[2*d+1]=255&c}),i}async function Ke(t,e,r){let n=Xa({hostname:t,port:e});try{await(function(a,i){return Promise.race([a,new Promise((s,d)=>setTimeout(()=>d(new Error("\u8FDE\u63A5\u8D85\u65F6\uFF08SYN \u88AB\u9759\u9ED8\u4E22\u5F03\uFF09")),i||6e3))])})(n.opened,r||6e3)}catch(a){try{n.close()}catch{}throw a}return n}async function Ht(t,e){return Ke(t.hostname,t.port,e||6e3)}function Wt(t){let e=t instanceof Uint8Array?t:new Uint8Array(t),r=e.length,n=8*r,a=new Uint8Array(1+(r+8>>6)<<6);a.set(e),a[r]=128;let i=new DataView(a.buffer);i.setUint32(a.length-8,Math.floor(n/4294967296),!1),i.setUint32(a.length-4,n>>>0,!1);let s=1732584193,d=4023233417,c=2562383102,u=271733878,l=3285377520,p=new Uint32Array(80);for(let b=0;b<a.length;b+=64){for(let w=0;w<16;w++)p[w]=i.getUint32(b+4*w,!1);for(let w=16;w<80;w++)p[w]=pe(p[w-3]^p[w-8]^p[w-14]^p[w-16],1);let v=s,x=d,h=c,g=u,A=l;for(let w=0;w<80;w++){let U,T;w<20?(U=x&h|~x&g,T=1518500249):w<40?(U=x^h^g,T=1859775393):w<60?(U=x&h|x&g|h&g,T=2400959708):(U=x^h^g,T=3395469782);let y=pe(v,5)+U+A+T+p[w]>>>0;A=g,g=h,h=pe(x,30),x=v,v=y}s=s+v>>>0,d=d+x>>>0,c=c+h>>>0,u=u+g>>>0,l=l+A>>>0}let f=new Uint8Array(20),m=new DataView(f.buffer);return m.setUint32(0,s,!1),m.setUint32(4,d,!1),m.setUint32(8,c,!1),m.setUint32(12,u,!1),m.setUint32(16,l,!1),f}function ln(t,e){let r=t;r.length>64&&(r=Wt(r));let n=new Uint8Array(64),a=new Uint8Array(64);for(let i=0;i<64;i++)n[i]=54^(i<r.length?r[i]:0),a[i]=92^(i<r.length?r[i]:0);return Wt(H(a,Wt(H(n,e))))}function cn(t,e,r){let n=ln(e&&e.length?e:new Uint8Array(20),t),a=new Uint8Array(0),i=new Uint8Array(0);for(let s=1;i.length<r;s++){let d=new Uint8Array([s]);a=ln(n,H(H(a,oe.encode("ss-subkey")),d)),i=H(i,a)}return i.slice(0,r)}function oo(t,e,r){let n=new Uint32Array(16);n[0]=1634760805,n[1]=857760878,n[2]=2036477234,n[3]=1797285236;let a=new DataView(t.buffer,t.byteOffset,32);for(let l=0;l<8;l++)n[4+l]=a.getUint32(4*l,!0);n[12]=e>>>0;let i=new DataView(r.buffer,r.byteOffset,12);n[13]=i.getUint32(0,!0),n[14]=i.getUint32(4,!0),n[15]=i.getUint32(8,!0);let s=n.slice(),d=(l,p,f,m)=>{s[l]=s[l]+s[p]>>>0,s[m]=pe(s[m]^s[l],16),s[f]=s[f]+s[m]>>>0,s[p]=pe(s[p]^s[f],12),s[l]=s[l]+s[p]>>>0,s[m]=pe(s[m]^s[l],8),s[f]=s[f]+s[m]>>>0,s[p]=pe(s[p]^s[f],7)};for(let l=0;l<10;l++)d(0,4,8,12),d(1,5,9,13),d(2,6,10,14),d(3,7,11,15),d(0,5,10,15),d(1,6,11,12),d(2,7,8,13),d(3,4,9,14);let c=new Uint8Array(64),u=new DataView(c.buffer);for(let l=0;l<16;l++)s[l]=s[l]+n[l]>>>0,u.setUint32(4*l,s[l],!0);return c}function Qe(t,e,r,n){let a=n.slice(),i=Math.ceil(n.length/64);for(let s=0;s<i;s++){let d=oo(t,r+s,e),c=64*s,u=Math.min(64,a.length-c);for(let l=0;l<u;l++)a[c+l]^=d[l]}return a}function dn(t,e){let r=0n,n=0n;for(let d=0;d<16;d++)r|=BigInt(t[d])<<BigInt(8*d),n|=BigInt(t[16+d])<<BigInt(8*d);r&=0x0ffffffc0ffffffc0ffffffc0fffffffn;let a=0n,i=(1n<<130n)-5n;for(let d=0;d<e.length;d+=16){let c=1n;for(let u=Math.min(16,e.length-d)-1;u>=0;u--)c=c<<8n|BigInt(e[d+u]);a=(a+c)*r%i}a=a+n&(1n<<128n)-1n;let s=new Uint8Array(16);for(let d=0;d<16;d++)s[d]=Number(a>>BigInt(8*d)&0xffn);return s}async function pn(t,e){let r=new Uint8Array(12),n=()=>{let i=r.slice();for(let s=11;s>=0&&(i[s]++,i[s]===0);s--);return i};if(o("Q0hBQ0hBMjA=")+"-POLY1305"===t)return{seal:i=>(function(s,d,c){let u=new Uint8Array(0),l=Qe(s,d,0,new Uint8Array(32)),p=Qe(s,d,1,c),f=v=>new Uint8Array((16-v%16)%16),m=v=>{let x=new Uint8Array(8),h=new DataView(x.buffer);return h.setUint32(0,v>>>0,!0),h.setUint32(4,Math.floor(v/4294967296),!0),x},b=H(u,H(f(u.length),H(p,H(f(p.length),H(m(u.length),m(p.length))))));return H(p,dn(l,b))})(e,n(),i),open(i){let s=(function(d,c,u){if(u.length<16)throw new Error("SS AEAD \u6570\u636E\u8FC7\u77ED");let l=u.subarray(0,u.length-16),p=u.subarray(u.length-16),f=new Uint8Array(0),m=h=>new Uint8Array((16-h%16)%16),b=h=>{let g=new Uint8Array(8),A=new DataView(g.buffer);return A.setUint32(0,h>>>0,!0),A.setUint32(4,Math.floor(h/4294967296),!0),g},v=dn(Qe(d,c,0,new Uint8Array(32)),H(f,H(m(f.length),H(l,H(m(l.length),H(b(f.length),b(l.length))))))),x=0;for(let h=0;h<16;h++)x|=v[h]^p[h];return x!==0?null:Qe(d,c,1,l)})(e,n(),i);if(!s)throw new Error("SS AEAD \u89E3\u5BC6\u5931\u8D25\uFF08\u5BC6\u7801/\u52A0\u5BC6\u65B9\u5F0F\u4E0E\u670D\u52A1\u5668\u4E0D\u5339\u914D\uFF09");return s}};let a=await crypto.subtle.importKey("raw",e,{name:t},!1,["encrypt","decrypt"]);return{seal:async i=>new Uint8Array(await crypto.subtle.encrypt({name:t,iv:n()},a,i)),async open(i){try{return new Uint8Array(await crypto.subtle.decrypt({name:t,iv:n()},a,i))}catch{throw new Error("SS AEAD \u89E3\u5BC6\u5931\u8D25\uFF08\u5BC6\u7801/\u52A0\u5BC6\u65B9\u5F0F\u4E0E\u670D\u52A1\u5668\u4E0D\u5339\u914D\uFF09")}}}}async function un(t,e){let r=new Uint8Array([e.length>>8&255,255&e.length]);return H(await t.seal(r),await t.seal(e))}function H(t,e){let r=new Uint8Array(t.length+e.length);return r.set(t,0),r.set(e,t.length),r}function io(t,e){e:for(let r=0;r<=t.length-e.length;r++){for(let n=0;n<e.length;n++)if(t[r+n]!==e[n])continue e;return r}return-1}var Q="cmliussss.net",fn={HK:o("cHJveHlpcA==")+".hk."+Q,US:o("cHJveHlpcA==")+".us."+Q,SG:o("cHJveHlpcA==")+".sg."+Q,JP:o("cHJveHlpcA==")+".jp."+Q,KR:o("cHJveHlpcA==")+".kr."+Q,DE:o("cHJveHlpcA==")+".de."+Q,SE:o("cHJveHlpcA==")+".se."+Q,NL:o("cHJveHlpcA==")+".nl."+Q,FI:o("cHJveHlpcA==")+".fi."+Q,GB:o("cHJveHlpcA==")+".gb."+Q,Oracle:o("cHJveHlpcA==")+".oracle."+Q,DigitalOcean:o("cHJveHlpcA==")+".digitalocean."+Q,Vultr:o("cHJveHlpcA==")+".vultr."+Q,Multacom:o("cHJveHlpcA==")+".multacom."+Q},mn=(()=>{let t=Object.create(null),e=(r,n)=>{for(let a of[].concat(n))t[a]=r};return e("HK","HKG"),e("AU",["SYD","MEL","BNE","PER","ADL","CBR"]),e("SG","SIN"),e("JP",["NRT","HND","KIX","TYO","OSA","NGO","CTS","FUK","OKA"]),e("KR",["ICN","SEL","PUS"]),e("DE",["FRA","MUC","DUS","BER","HAM","STR","VIE","ZRH","CDG","MAD","MXP","FCO","PRG","WAW"]),e("SE","ARN"),e("NL","AMS"),e("FI","HEL"),e("GB",["LHR","LGW","MAN","EDI"]),e("US",["LAX","SJC","SFO","SEA","PDX","SAN","LAS","PHX","SLC","DEN","DFW","IAH","AUS","ORD","MSP","DTW","STL","MCI","ATL","MIA","MCO","BNA","CLT","IAD","BOS","EWR","JFK","PHL","YYZ","YVR","YUL","MEX","GRU"]),e("TW",["TPE","KHH","TSA","RMQ"]),t})(),hn=t=>{let e=String(t||"").toUpperCase();return e?mn[e]?mn[e]:/^[A-Z]{2}$/.test(e)?e:"US":"US"},qe=new Map,so=t=>{let e=String(t||"").trim();if(!e)return[];let r=qe.get(e);if(r)return r;let n=[];for(let a of e.split(/[,;\n\r]+/)){let i=a.trim();if(!i)continue;let s="",d=/^([A-Za-z]{2})\.(.+)$/.exec(i);if(d&&ue(Te(d[2],443).host)&&(s=d[1].toUpperCase(),i=d[2]),!s){let u=/^(.+)#([A-Za-z]{2})$/.exec(i);u&&(s=u[2].toUpperCase(),i=u[1])}let c=Te(i,443);if(c.host){if(!s&&!ue(c.host)){for(let u of c.host.toUpperCase().split(/[^A-Z0-9]+/))if(/^[A-Z]{2}$/.test(u)&&u!=="IP"&&u!=="CF"){s=u;break}}n.push({host:c.host,port:c.port,cc:s})}}return qe.size>32&&qe.clear(),qe.set(e,n),n},gn=new Map;async function bn(t,e){if(e=e||443,ue(t))return[{hostname:t,port:e}];let r=t+":"+e,n=Date.now(),a=gn.get(r);if(a&&n-a.t<3e5)return a.ips;let i=["https://cloudflare-dns.com/dns-query","https://dns.alidns.com/resolve","https://doh.pub/dns-query"],s=async(p,f)=>{for(let m of i)try{let b=await Sn(m+"?name="+encodeURIComponent(t)+"&type="+p,{headers:{accept:"application/dns-json"}},4e3);if(!b||!b.ok)continue;return((await b.json()).Answer||[]).filter(v=>v.type===f).map(v=>v.data)}catch{}return[]},d=await s("TXT",16),c=[];for(let p of d){let f=String(p).replace(/^"|"$/g,"").replace(/\\010/g,",").replace(/\n/g,",").trim();if(!f)continue;if("@"+o("ZWR0dW5uZWw=")===f)break;let m=f.split(/[,;\s]+/).map(v=>v.trim()).filter(Boolean),b=[];for(let v of m){let{host:x,port:h}=Te(v,e);ue(x)&&b.push({hostname:x,port:h})}if(b.length){c=b;break}}c.length||(c=(await s("A",1)).filter(p=>/^\d+\.\d+\.\d+\.\d+$/.test(p)).map(p=>({hostname:p,port:e}))),c.length||(c=(await s("AAAA",28)).filter(p=>ue(p)).map(p=>({hostname:p,port:e})));let u=new Set,l=c.filter(p=>{let f=p.hostname+":"+p.port;return!u.has(f)&&(u.add(f),!0)});return l.length&&gn.set(r,{t:n,ips:l}),l}async function _t(t){if(!t||!t.length)return null;let e=!1;return await new Promise(r=>{let n=t.length,a=i=>{if(n--,i)if(e)try{i.close()}catch{}else e=!0,r(i);else n<=0&&!e&&r(null)};for(let i of t)Promise.resolve().then(i).then(s=>a(s&&s.readable?s:null),()=>a(null))})}async function vn(t,e,r){let n=null,a=p=>{if(p&&p!==n)try{p.close()}catch{}},i=t?Promise.resolve().then(t).then(p=>p&&p.readable?p:null,()=>null):Promise.resolve(null),s=e&&e.length?_t(e).then(p=>p&&p.readable?p:null,()=>null):Promise.resolve(null),d=null,c=await Promise.race([i,new Promise(p=>{d=setTimeout(()=>p("__GRACE__"),r)})]);if(d&&(clearTimeout(d),d=null),c&&c!=="__GRACE__")return n=c,s.then(a),n;let u=await s;if(u)return n=u,i.then(a),n;let l=await i;return l?(n=l,n):null}function lo(t){return!t||t.byteLength<3?"unknown":t[0]===22&&t[1]===3?"tls":"nontls"}async function co(t,e,r,n,a){let i=(function(y){if(!y)return null;let k=o("c29ja3M1"),E=String(y).trim(),C=E.match(Ba);if(C&&(k=C[1].toLowerCase(),E=C[2]),k==="ss")return(function(V){let $=V,M="",D=V.indexOf("#");D>=0&&($=V.slice(0,D));let L=$.lastIndexOf("@");if(L>=0)M=$.slice(0,L),$=$.slice(L+1);else{let G=nn($);if(G&&G.includes("@")){let Y=G.lastIndexOf("@");M=G.slice(0,Y),$=G.slice(Y+1)}}let W="",X="";if(M){let G=nn(M)||M;try{G=decodeURIComponent(G)}catch{}let Y=G.indexOf(":");Y>0?(W=G.slice(0,Y),X=G.slice(Y+1)):W=G}let{host:ie,port:_}=Te($,8388);return{type:"ss",host:ie,port:_,method:W,password:X}})(E);let S="",P="";if(E.includes("@")){let[V,$]=E.split("@"),M=L=>{try{return decodeURIComponent(L)}catch{return L}},D=V.indexOf(":");D>=0?(S=M(V.slice(0,D)),P=M(V.slice(D+1))):S=M(V),E=$}let I=k==="http"?80:k==="https"?443:1080,{host:R,port:N}=Te(E,I);return{type:k,host:R,port:N,user:S,pass:P}})(e.outboundProxy),s=e.outboundMode||"",d=a!=="nontls",c=i?i.type==="http"||i.type==="https"?y=>(async function(k,E){let C=await Ke(k.host,k.port,6e3),S=C.writable.getWriter(),P=C.readable.getReader(),I="";k.user&&(I=o("UHJveHktQXV0aG9yaXphdGlvbg==")+": Basic "+(function($){let M="";for(let D=0;D<$.length;D+=32768)M+=String.fromCharCode(...$.subarray(D,D+32768));return btoa(M)})(oe.encode(`${k.user}:${k.pass}`))+`\r
`);let R=`${o("Q09OTkVDVA==")} ${E.hostname}:${E.port} HTTP/1.1\r
Host: ${E.hostname}:${E.port}\r
${I}\r
`;await S.write(oe.encode(R));let{head:N,leftover:V}=await(async function($){let M=new Uint8Array(0);for(;M.length<65536;){let{done:D,value:L}=await $.read();if(D)break;M=H(M,L);let W=io(M,[13,10,13,10]);if(W>=0)return{head:le.decode(M.subarray(0,W)),leftover:M.subarray(W+4)}}return{head:le.decode(M),leftover:new Uint8Array(0)}})(P);if(!/^HTTP\/\d\.\d\s+2\d\d/i.test(N))throw new Error(o("Q09OTkVDVA==")+" \u5931\u8D25: "+N.split(`\r
`)[0]);return V&&V.byteLength>0&&(C._preamble=V),S.releaseLock(),P.releaseLock(),C})(i,y):i.type==="ss"?y=>(async function(k){let E=(function(M){let D=String(M||"").toLowerCase().replace(/_/g,"-");return o("YWVzLTEyOC1nY20=")===D||D==="aes-128gcm"?{name:"AES-GCM",keyLen:16}:o("YWVzLTI1Ni1nY20=")===D||D==="aes-256gcm"?{name:"AES-GCM",keyLen:32}:o("Y2hhY2hhMjA=")+"-ietf-poly1305"===D||o("Y2hhY2hhMjA=")+"-poly1305"===D||o("Y2hhY2hhMjA=")+"poly1305"===D?{name:o("Q0hBQ0hBMjA=")+"-POLY1305",keyLen:32}:null})(k.method);if(!E)throw new Error("\u4E0D\u652F\u6301\u7684 SS \u52A0\u5BC6\u65B9\u5F0F: "+(k.method||"\uFF08\u672A\u6307\u5B9A\uFF09"));if(!k.password)throw new Error("SS \u51FA\u7AD9\u7F3A\u5C11\u5BC6\u7801");let C=await Ke(k.host,k.port,6e3),S=C.writable.getWriter(),P=C.readable.getReader(),I=new Uint8Array(0),R=async M=>{for(;I.length<M;){let{done:L,value:W}=await P.read();if(L)throw new Error("SS \u8FDE\u63A5\u88AB\u5173\u95ED");I=H(I,W)}let D=I.slice(0,M);return I=I.subarray(M),D},N=new Uint8Array(await crypto.subtle.digest("SHA-256",oe.encode(k.password))),V=crypto.getRandomValues(new Uint8Array(16)),$=await pn(E.name,await cn(N,V,E.keyLen));return await S.write(V),await S.write(await un($,new Uint8Array(0))),{readable:new ReadableStream({async start(M){try{let D=await R(16),L=await pn(E.name,await cn(N,D,E.keyLen));for(;;){let W=await L.open(await R(18)),X=W[0]<<8|W[1];if(X>16384)throw new Error("SS \u5206\u7247\u957F\u5EA6\u975E\u6CD5 "+X);let ie=await L.open(await R(X+16));X>0&&M.enqueue(ie)}}catch(D){try{M.error(D)}catch{}}}}),writable:new WritableStream({async write(M){let D=M instanceof Uint8Array?M:new Uint8Array(M);for(let L=0;L<D.length;L+=16384)await S.write(await un($,D.subarray(L,Math.min(D.length,L+16384))))},close(){try{S.close()}catch{}},abort(){try{S.abort()}catch{}}}),close(){try{C.close()}catch{}}}})(i):y=>(async function(k,E){let C=await Ke(k.host,k.port,6e3),S=C.writable.getWriter(),P=C.readable.getReader(),I=new Uint8Array(0),R=async L=>{for(;I.length<L;){let{done:X,value:ie}=await P.read();if(X)throw new Error("\u8FDE\u63A5\u88AB\u5173\u95ED");I=H(I,ie)}let W=I.slice(0,L);return I=I.subarray(L),W},N=k.user?[5,2,0,2]:[5,1,0];await S.write(new Uint8Array(N));let V=await R(2);if(V[0]!==5||V[1]===255)throw new Error(o("U09DS1M1")+" \u63E1\u624B\u5931\u8D25");if(V[1]===2){if(!k.user)throw new Error(o("U09DS1M1")+" \u670D\u52A1\u5668\u8981\u6C42\u8BA4\u8BC1\u4F46\u672A\u63D0\u4F9B\u51ED\u636E");let L=oe.encode(k.user),W=oe.encode(k.pass),X=new Uint8Array([1,L.length,...L,W.length,...W]);if(await S.write(X),(await R(2))[1]!==0)throw new Error(o("U09DS1M1")+" \u8BA4\u8BC1\u5931\u8D25")}else if(V[1]!==0)throw new Error(o("U09DS1M1")+" \u4E0D\u652F\u6301\u7684\u8BA4\u8BC1\u65B9\u6CD5 "+V[1]);let $=oe.encode(E.hostname),M;M=/^\d+\.\d+\.\d+\.\d+$/.test(E.hostname)?new Uint8Array([5,1,0,1,...E.hostname.split(".").map(Number),E.port>>8&255,255&E.port]):new Uint8Array([5,1,0,3,$.length,...$,E.port>>8&255,255&E.port]),await S.write(M);let D=await R(4);if(D[1]!==0)throw new Error(o("U09DS1M1")+" \u8FDE\u63A5\u5931\u8D25 \u7801"+D[1]);if(D[3]===1)await R(6);else if(D[3]===3){let L=(await R(1))[0];await R(L+2)}else D[3]===4&&await R(18);return I.byteLength>0&&(C._preamble=I),S.releaseLock(),P.releaseLock(),C})(i,y):null,u,l=async y=>{try{let k=await y();if(k)return k}catch(k){u=k}return null},p=()=>{throw u||new Error("\u6240\u6709\u51FA\u7AD9\u65B9\u5F0F\u5747\u5931\u8D25")},f=e.proxyIP?so(e.proxyIP):[],m=hn(r),b=String(r||"").toUpperCase(),v=[];if(f.length&&d){for(let y of f)y.cc&&(y.cc===m||y.cc===b)&&v.push(y);for(let y of f)y.cc||v.push(y);v.length||v.push(f[0]);for(let y of v.slice(0,3)){let k=await l(async()=>{let E=[];try{E=await bn(y.host,y.port)}catch{}E.length||(E=[{hostname:y.host,port:y.port}]);let C=await _t(E.slice(0,4).map(S=>()=>l(()=>Ht(S,4e3))));if(C)return C});if(k)return k}}let x={hostname:t.addr,port:t.port},h=()=>{if(!d)return[];let y=hn(r);return[y,...Object.keys(fn).filter(E=>E!==y)].slice(0,2).map((E,C)=>async()=>{let S=fn[E];if(!S)return null;let P=[];try{P=await bn(S,443)}catch{return null}if(!P.length)return null;let I=P.slice(0,C===0?2:1);return await _t(I.map(R=>()=>l(()=>Ht(R,4e3))))})},g=()=>l(()=>Ht(x,4e3)),A=c?()=>l(()=>c(x)):null,w=Qa(t.addr)?0:300,U=()=>vn(g,h().slice(0,3),w);if(s==="only"&&A){let y=await A();return y||await vn(null,h().slice(0,4),0)||p()}if(s===""&&A){let y=await A();return y||await U()||p()}let T=await U();if(T)return T;if(A){let y=await A();if(y)return y}return p()}async function kn(t,e){let r=new WebSocketPair,[n,a]=Object.values(r);try{a.accept({allowHalfOpen:!0})}catch{a.accept()}a.binaryType="arraybuffer";let i=null,s=null,d=!1,c=null,u=null,l=!1,p=v=>{try{a.send(v)}catch{}},f=async(v,x)=>{if(v&&v.byteLength&&(c=c?H(c,v):v),!c)return;if(c.byteLength>65536)throw new Error("\u63E1\u624B\u5934\u8D85\u8FC7 64KB\uFF0C\u5173\u95ED\u8FDE\u63A5");let h,g;try{let U=(function(T,y){if(!y.enableTrojan||!T||T.byteLength<58)return!1;let k=T.subarray(0,56);if(le.decode(k).toLowerCase()===sn(y.trojanPassword||y.uuid))return!0;if(T[56]===13&&T[57]===10){for(let E=0;E<56;E++){let C=k[E];if(!(C>=48&&C<=57||C>=97&&C<=102||C>=65&&C<=70))return!1}return!0}return!1})(c,e);if(!U&&c.byteLength>0&&c[0]!==0&&c.byteLength<58)return;g=!U,h=U?(function(T){if(!T||T.byteLength<66)throw new Error(o("VHJvamFu")+" \u5934\u90E8\u8FC7\u77ED");let y=new DataView(T.buffer,T.byteOffset,T.byteLength),k=58,E=y.getUint8(k);k+=1;let C=y.getUint8(k),S,P;if(k+=1,C===1)S=`${y.getUint8(k)}.${y.getUint8(k+1)}.${y.getUint8(k+2)}.${y.getUint8(k+3)}`,P=4;else if(C===3){let R=y.getUint8(k);S=le.decode(T.subarray(k+1,k+1+R)),P=1+R}else{if(C!==4)throw new Error("\u65E0\u6CD5\u8BC6\u522B\u7684\u5730\u5740\u7C7B\u578B");S=wn(T.subarray(k,k+16)),P=16}k+=P;let I=y.getUint16(k);return k+=2,k+=2,{command:E,port:I,addr:S,password:le.decode(T.subarray(0,56)),headerLength:k}})(c):to(c)}catch(U){if(/头部过短/.test(U.message||""))return;throw U}!l&&g&&h.command!==2&&(l=!0,p(new Uint8Array([0,0])));let A=lo(c.byteLength>h.headerLength?c.subarray(h.headerLength):null);if(A==="unknown"&&!x)return void(u||(u=setTimeout(()=>{u=null,f(new Uint8Array(0),!0).catch(U=>{try{a.close(1011,String(U&&U.message||U))}catch{}})},80)));if(u&&(clearTimeout(u),u=null),d)return;if(d=!0,h.command===2){try{let U=c.subarray(h.headerLength);if(h.port===53&&U.byteLength>=12){let T=await(async function(y){if(!y||y.byteLength<17)return null;let k=new DataView(y.buffer,y.byteOffset,y.byteLength),E=k.getUint16(0);if(32768&k.getUint16(2)||k.getUint16(4)!==1)return null;let C=12,S=[];for(;C<y.byteLength;){let _=k.getUint8(C);if(_===0){C++;break}if(!(192&~_)){C+=2;break}if(C+1+_>y.byteLength)return null;S.push(le.decode(y.subarray(C+1,C+1+_))),C+=1+_}if(C+4>y.byteLength||S.length===0)return null;let P=k.getUint16(C),I=k.getUint16(C+2),R=C+4;if(P!==1&&P!==28)return null;let N=S.join("."),V=y.subarray(12,R),$=null;for(let _ of no)try{let G=await Sn(_+"?name="+encodeURIComponent(N)+"&type="+P,{headers:{accept:"application/dns-json"}},5e3);if(!G||!G.ok)continue;let Y=await G.json();if(!Y||Y.Status!==0)continue;let me=(Y.Answer||[]).filter(ae=>ae.type===P&&(ae.type===1?ue(String(ae.data)):/^[0-9a-fA-F:]+$/.test(String(ae.data))));if(me.length){$=me;break}}catch{}if(!$)return null;let M=new Uint8Array(12),D=new DataView(M.buffer);D.setUint16(0,E),D.setUint16(2,33152),D.setUint16(4,1),D.setUint16(6,$.length);let L=[M,V];for(let _ of $){let G=String(_.data),Y=_.type===1?Uint8Array.from(G.split(".").map(Number)):ao(G);if(Y.length!==(_.type===1?4:16))continue;let me=new Uint8Array(10),ae=new DataView(me.buffer);ae.setUint16(0,49164),ae.setUint16(2,_.type),ae.setUint16(4,I===0?1:I),ae.setUint32(6,Number(_.TTL)||300),L.push(me,new Uint8Array([Y.length>>8&255,255&Y.length]),Y)}let W=0;L.forEach(_=>W+=_.byteLength);let X=new Uint8Array(W),ie=0;for(let _ of L)X.set(_,ie),ie+=_.byteLength;return X})(U);T&&p(T)}}catch{}try{a.close(1e3)}catch{}return}let w=await co(h,e,t.cf&&t.cf.colo,0,A);i=w,s=w.writable.getWriter(),w._preamble&&w._preamble.byteLength>0&&p(w._preamble),c&&c.byteLength>h.headerLength&&await s.write(c.subarray(h.headerLength)),c=null,(async function(U,T,y){try{for(;;){let{done:k,value:E}=await U.read();if(k)break;T(E)}}catch{}try{y&&y()}catch{}})(w.readable.getReader(),p,()=>{try{a.close(1e3)}catch{}})},m=(function(v,x){if(!v)return null;let h=String(v).trim();if(!h||h.length>8192||!/^[A-Za-z0-9\-_+/=]+$/.test(h))return null;let g=null;try{let A=h.replace(/-/g,"+").replace(/_/g,"/"),w=A.length%4?"=".repeat(4-A.length%4):"",U=atob(A+w);g=new Uint8Array(U.length);for(let T=0;T<U.length;T++)g[T]=U.charCodeAt(T)}catch{return null}if(!g.byteLength||g.byteLength>6144)return null;if(g.byteLength>=17&&g[0]===0){let A=(function(w){let U=String(w||"").replace(/-/g,"");if(U.length!==32)return null;let T=new Uint8Array(16);for(let y=0;y<16;y++){let k=parseInt(U.substr(2*y,2),16);if(isNaN(k))return null;T[y]=k}return T})(x.uuid);if(!A)return g;for(let w=0;w<16;w++)if(g[w+1]!==A[w])return null;return g}return x.enableTrojan&&g.byteLength>=58&&g[56]===13&&g[57]===10&&le.decode(g.subarray(0,56)).toLowerCase()===sn(x.trojanPassword||x.uuid)?g:null})(t.headers.get("sec-websocket-protocol"),e);m&&f(m).catch(v=>{try{a.close(1011,String(v&&v.message||v))}catch{}}),a.addEventListener("message",async v=>{try{let x=typeof v.data=="string"?oe.encode(v.data):new Uint8Array(v.data);d?s?await s.write(x):c=c?H(c,x):x:await f(x)}catch(x){try{a.close(1011,String(x&&x.message||x))}catch{}}});let b=()=>{if(u&&(clearTimeout(u),u=null),i){try{i.close()}catch{}i=null}};return a.addEventListener("close",b),a.addEventListener("error",b),new Response(null,{status:101,webSocket:n})}function Sn(t,e,r){return new Promise(n=>{let a=new AbortController,i=setTimeout(()=>a.abort(),r);fetch(t,Object.assign({},e,{signal:a.signal})).then(s=>{clearTimeout(i),n(s)}).catch(()=>{clearTimeout(i),n(null)})})}var Wi="https://api."+o("Y2xvdWRmbGFyZWNsaWVudA==")+".com/v0a5641/reg",zi="https://api."+o("Y2xvdWRmbGFyZWNsaWVudA==")+".com/v0a2158/reg",_i=o("d3d3Lm1pY3Jvc29mdC5jb20=");var Gi=String.raw`
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
    <div class="bt"><b>${rn}</b><span>Cloudflare 隧道面板</span></div>
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
      <div class="view-head"><h2>关于项目</h2><p>${rn} — Cloudflare 边缘管理面板（独立界面 + 独立实现）</p></div>
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

`;nr();async function ar(t,e,r,n,a,i){if((i?.impl??"vendor")==="self")return await rr(t,e,r,n,a,i?.diagnostics);try{return kn(t,{uuid:r.uuid,enableTrojan:r.enableTrojan,trojanPassword:r.trojanPassword,proxyIP:r.proxyIp,outboundProxy:"",outboundMode:"",path:r.wsPath.replace(/^\//,"")})}catch{return new Response("\u670D\u52A1\u6682\u4E0D\u53EF\u7528",{status:503,headers:{"Content-Type":"text/plain; charset=utf-8"}})}}function or(t){let e=(t??"").trim().toLowerCase();return e==="vendor"||e==="cfnext"||e==="next"?"vendor":"self"}sr();Qt();function lr(t){let e=[];return e.push(...Re(t.proxyIp,"direct")),e.push(...Re(t.socks5,"socks5")),e.push(...Re(t.httpProxy,"http")),e}async function ca(t,e,r){let n=new URL(t.url);if(n.pathname==="/__edge_probe")return Ge(t);if(n.pathname==="/__diag"){let{recentDiagnostics:d}=await Promise.resolve().then(()=>(nr(),ia)),{recentXhttpDiagnostics:c}=await Promise.resolve().then(()=>(sr(),la));return new Response(JSON.stringify({ok:!0,impl:or(e.DATAPLANE),recent:d(),xhttp:c()},null,2),{status:200,headers:{"Content-Type":"application/json; charset=utf-8"}})}let a=await tn(e),i=t.headers.get("Upgrade")?.toLowerCase(),s=or(e.DATAPLANE);return n.pathname===a.wsPath?i!=="websocket"?ve("\u8BE5\u8DEF\u5F84\u9700\u8981 WebSocket \u5347\u7EA7",400):await ar(t,"vless",a,lr(a),r,{impl:s}):a.enableTrojan&&n.pathname===a.trojanPath?i!=="websocket"?ve("\u8BE5\u8DEF\u5F84\u9700\u8981 WebSocket \u5347\u7EA7",400):await ar(t,"trojan",a,lr(a),r,{impl:s}):a.enableXhttp&&n.pathname===a.xhttpPath?t.method!=="POST"?ve("XHTTP \u9700\u8981 POST \u8BF7\u6C42",405):await ir(t,a,lr(a)):null}var Zs={async fetch(t,e,r){try{return await en(t,e)??await ca(t,e,r)??It(200)}catch{return It(500)}}};export{Zs as default};
