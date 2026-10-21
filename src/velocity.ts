/** Rotate an ECEF vector into the geodetic ENU basis at this epoch's rover position. */
export function enuVelocity(velocity: readonly number[], position: readonly number[]): [number,number,number] | null {
 if(velocity.length!==3||position.length!==3||!velocity.every(Number.isFinite)||!position.every(Number.isFinite)||Math.hypot(...position)<1e6)return null;
 const [x,y,z]=position,lon=Math.atan2(y,x),p=Math.hypot(x,y),e2=0.00669437999014;
 let lat=Math.atan2(z,p*(1-e2));
 for(let i=0;i<10;i++){
  const radius=6378137/Math.sqrt(1-e2*Math.sin(lat)**2);
  lat=Math.atan2(z+e2*radius*Math.sin(lat),p);
 }
 const [vx,vy,vz]=velocity,s=Math.sin(lat),c=Math.cos(lat),sl=Math.sin(lon),cl=Math.cos(lon);
 return [-sl*vx+cl*vy,-s*cl*vx-s*sl*vy+c*vz,c*cl*vx+c*sl*vy+s*vz];
}
