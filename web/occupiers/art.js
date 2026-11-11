// Original voxel toys. Shared, precompiled geometry; continuous rotation at every angle.
export const shade=(c,k)=>'#'+[1,3,5].map(i=>Math.max(0,Math.min(255,Math.round(parseInt(c.slice(i,i+2),16)*k))).toString(16).padStart(2,'0')).join('');
function boxes(kind,color){
 const all=[],b=(x,y,z,w,d,h,c)=>all.push({x,y,z,w,d,h,c}),ink='#17213b',white='#fffef5',gold='#ffd91a';
 if(kind==='car'){
  b(-11,-7,3,22,14,5,color);b(-12,-7,2,24,14,2,'#087cab');b(-6,-6,8,12,12,7,color);
  b(-5,-5,15,10,10,1,gold);b(-4,-4,15.5,8,8,1,'#342133');
  b(5.8,-5,9,1,10,5,white);b(6.8,-4,10,.5,8,3,'#62eaff');
  b(-5,-6.5,10,10,.6,3,'#59dfff');b(-5,5.9,10,10,.6,3,'#59dfff');
  b(8,-6,6,3,12,2,'#17ebfc');b(10.7,-5.5,4.5,.5,3,2,white);b(10.7,2.5,4.5,.5,3,2,white);b(11,-7,2,1,14,1.5,white);
  b(-11,-5,5,.5,3,1.5,'#fa214c');b(-11,2,5,.5,3,1.5,'#fa214c');
  for(const x of [-8,6])for(const y of [-8,5]){b(x,y,0,4,3,5,ink);b(x+.8,y<0?y-.1:y+2.9,1.2,2.4,.3,2.4,'#b4daf0');}
  b(5.5,-7.8,10,2,2,1.5,color);b(5.5,5.8,10,2,2,1.5,color);
 }else if(kind==='cow'){
  b(-10,-7,4,19,14,10,white);b(4,-6,12,8,12,7,white);b(10,-6,8,4,12,5,'#ff9cae');
  b(-8,-7.2,9,5,.4,5,ink);b(-2,6.8,5,5,.4,7,ink);b(-8,-2,14,5,6,.5,ink);b(1,-6,14,4,4,.5,ink);
  for(const y of [-6,3]){b(5,y,18,3,3,4,gold);b(4,y<0?-10:6,15,5,4,2,white);b(12.8,y+1,10,1,2,1.5,ink);}
  for(const x of [-8,5])for(const y of [-6,3]){b(x,y,0,3,3,5,ink);}
  for(const y of [-6.2,5.8]){b(8,y,14,3,.5,3,ink);b(8,y,16,1,.6,1,white);}
  b(-12,-1,6,3,2,7,white);b(-13,-1,5,2,2,3,ink);
 }else if(kind==='crab'){
  b(-8,-7,3,16,14,9,color);b(-7,-6,12,14,12,1,shade(color,1.1));
  for(const y of [-1,1])for(const x of [-6,0,5]){b(x,y<0?-11:7,2,2,4,2,color);b(x+1,y<0?-13:10,1,3,3,2,shade(color,.84));}
  for(const y of [-11,6]){b(7,y+2,4,6,3,3,color);b(11,y,4,5,5,5,color);b(15,y,4,2,2,5,color);b(15,y+3,4,2,2,5,color);}
  for(const y of [-4,2]){b(5,y,12,2,2,4,color);b(6,y-.5,14,3,3,4,white);b(8.8,y,14.5,.5,1.5,2,ink);}
  b(8,-3,5,.5,6,2,ink);b(8.6,-2,6,.4,4,1,white);
 }else if(kind==='fox'){
  const orange='#f47720';
  b(-9,-5,4,16,10,8,orange);b(2,-6,10,10,12,8,orange);
  b(10,-4,10,5,8,4,'#fff4dc');b(14,-2,12,2,4,2,ink);
  for(const y of [-6,3]){b(4,y,18,4,3,5,orange);b(5,y+.6,19,2,1.8,3,ink);b(8,y<0?-6.2:5.8,15,2,.5,2,ink);}
  b(9,-3,8,3,6,2,'#fff4dc');
  for(const x of [-7,4])for(const y of [-5,2])b(x,y,0,3,3,5,ink);
  b(-16,-3,6,8,6,5,orange);b(-20,-2,9,5,4,4,'#fff4dc');
 }else if(kind==='penguin'){
  b(-7,-6,3,14,12,13,ink);b(-5,-5,16,11,10,4,ink);
  b(6.8,-5,5,.5,10,10,white);b(6.8,-4,16,.6,8,3,white);
  b(7,-3,13,6,6,2,'#ff9d00');
  for(const y of [-4,2]){b(7,y,17,1,2,2,ink);b(-9,y<0?-8:6,5,4,2,9,ink);b(2,y,0,8,3,3,'#ff9d00');}
  b(-6,-6,11,12,12,2,color);b(6,-5.5,8,2,3,5,color);
 }else if(kind==='dino'){
  const green='#33c42b';
  b(-8,-6,4,15,12,9,green);b(1,-5,13,7,10,7,green);b(6,-5,14,9,10,5,green);
  b(10,-4,12,5,8,2,'#b6ed68');b(14.7,-3,14,.5,6,1,ink);
  for(const y of [-5.2,4.8]){b(10,y,17,2,.5,2,ink);b(3,y<0?-8:6,7,5,2,3,green);b(-5,y<0?-7:3,0,6,4,6,green);}
  b(-14,-3,5,7,6,6,green);b(-19,-2,6,6,4,3,green);
  for(const x of [-16,-10,-4])b(x,-1,11,3,2,3,'#ffbe00');
  b(5,-3,6,2,6,6,'#b6ed68');
 }else if(kind==='robot'){
  b(-7,-6,3,14,12,10,color);b(-6,-6,14,12,12,7,white);
  b(5.8,-5,15,1,10,5,ink);
  for(const y of [-4,2]){b(6.8,y,17,.6,2,2,'#22e4f2');b(-5,y,0,4,3,4,ink);}
  b(-1,-1,21,2,2,2,ink);b(-2,-2,23,4,4,2,color);
  for(const y of [-10,6]){b(-4,y,7,6,4,7,'#95b1c4');b(1,y,5,4,4,3,ink);}
  b(6.8,-3,8,.6,6,3,ink);b(7.4,-2,9,.5,2,1,'#ffdf20');
 }else{
  b(-9,-6,3,17,12,7,'#ffc400');b(0,-5,9,10,10,10,'#ffe315');b(9,-4,10,6,8,3,'#ff7b00');
  b(-7,-7,6,10,2,4,'#ffde13');b(-7,5,6,10,2,4,'#ffde13');b(-12,-3,9,4,6,3,'#ffdc00');
  for(const y of [-5.2,4.8]){b(6,y,14,2,.5,3,ink);b(6,y,16,1,.6,1,white);}
  b(-2,-5,0,7,3,3,'#ff8700');b(-2,2,0,7,3,3,'#ff8700');
 }
 if(kind!=='car')b(-10,-8,-1,20,16,1.5,color);
 return all;
}
const cache=new Map(),faceSpecs=[[[4,5,6,7],1.08],[[0,1,5,4],.72],[[1,2,6,5],.82],[[2,3,7,6],.88],[[3,0,4,7],.66]];
function mesh(kind,color){const key=kind+color;if(cache.has(key))return cache.get(key);const vertices=[],faces=[];
 for(const b of boxes(kind,color)){const offset=vertices.length;vertices.push([b.x,b.y,b.z],[b.x+b.w,b.y,b.z],[b.x+b.w,b.y+b.d,b.z],[b.x,b.y+b.d,b.z],[b.x,b.y,b.z+b.h],[b.x+b.w,b.y,b.z+b.h],[b.x+b.w,b.y+b.d,b.z+b.h],[b.x,b.y+b.d,b.z+b.h]);
 for(const [indices,tone]of faceSpecs){const ids=indices.map(i=>i+offset),center=[0,1,2].map(k=>ids.reduce((sum,i)=>sum+vertices[i][k],0)/4);faces.push({ids,center,color:shade(b.c,tone)});}}
 const result={vertices,faces};cache.set(key,result);return result;}
export function drawToy(ctx,x,y,size,angle,kind='car',color='#ffbe00'){
 const m=mesh(kind,color),c=Math.cos(angle),s=Math.sin(angle),scale=size/28;
 const project=([a,b,z])=>{const xx=a*c-b*s,yy=a*s+b*c;return[(xx-.22*yy)*scale,(.13*xx+.64*yy-.85*z)*scale];};
 let top=0;const projected=m.vertices.map(vertex=>{const point=project(vertex);top=Math.min(top,point[1]);return point;}),faces=[];
 for(const f of m.faces){const pts=f.ids.map(i=>projected[i]);const area=pts.reduce((sum,p,i)=>{const q=pts[(i+1)%4];return sum+p[0]*q[1]-q[0]*p[1];},0);if(area<=0)continue;
 const[a,b,z]=f.center,xx=a*c-b*s,yy=a*s+b*c;faces.push({pts,depth:.187*xx+.85*yy+.669*z,color:f.color});}
 faces.sort((a,b)=>a.depth-b.depth);ctx.save();ctx.translate(x,y);ctx.fillStyle='#d7e2e4';ctx.beginPath();ctx.ellipse(0,3*scale,13*scale,6*scale,0,0,Math.PI*2);ctx.fill();
 for(const f of faces){ctx.beginPath();f.pts.forEach((p,i)=>i?ctx.lineTo(...p):ctx.moveTo(...p));ctx.closePath();ctx.fillStyle=f.color;ctx.fill();}ctx.restore();return y+top;
}
export function drawPlayerLabel(ctx,x,y,name,color,size=18){ctx.save();ctx.translate(x,y);ctx.beginPath();ctx.moveTo(0,-7);ctx.bezierCurveTo(-3,-13,-9,-18,-9,-24);ctx.bezierCurveTo(-9,-37,9,-37,9,-24);ctx.bezierCurveTo(9,-18,3,-13,0,-7);ctx.fillStyle=color;ctx.fill();ctx.strokeStyle=shade(color,.64);ctx.lineWidth=1.2;ctx.stroke();ctx.beginPath();ctx.arc(0,-25,3,0,Math.PI*2);ctx.fillStyle='white';ctx.fill();ctx.font=`900 ${size}px Rubik, sans-serif`;ctx.textAlign='center';ctx.lineJoin='round';ctx.lineWidth=2.4;ctx.strokeStyle=shade(color,.53);ctx.strokeText(name,0,11);ctx.fillStyle=color;ctx.fillText(name,0,11);ctx.restore();}
