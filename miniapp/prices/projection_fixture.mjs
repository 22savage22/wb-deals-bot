// Browser-safe synthetic catalogue shared by both isolated staging drivers.
// No Node imports, external requests, credentials, real voters or AI calls.
const types=[
 ['Футболка хлопковая женская','Футболки','apparel'],['Кроссовки мужские','Кроссовки','shoes'],['Сумка женская','Сумки','bag'],['Ремень женский','Ремни','accessory'],
 ['Джинсы женские','Джинсы','apparel'],['Платье женское','Платья','apparel'],['Худи мужское','Худи','apparel'],['Серьги женские','Серьги','accessory'],
 ['Кепка унисекс','Кепки','accessory'],['Куртка мужская','Куртки','apparel'],['Лонгслив унисекс','Лонгсливы','apparel'],['Юбка женская','Юбки','apparel']
];
export function fixtureIdentity(pid){
 if(!Number.isSafeInteger(pid)||pid<900000||pid>=900300)throw Error('SYNTHETIC_PROJECTION_ID_REQUIRED');
 const n=pid-900000,[title,category,visualGroup]=types[n%types.length];
 return {id:pid,title:title+' Fixture '+pid,category,query:'fixture группа'+n%6,brand:'Fixture',visualGroup};
}
export function projectionFixtureVisualFields(identity,index){
 const field=(value,evidence)=>({value,confidence:.95,evidence:'Synthetic fixture '+evidence});
 const fields={color:field(['black','white','blue'][Math.floor(index/12)%3],'visible body colour'),pattern:field('solid','one consistent visible colour')};
 if(identity.visualGroup==='apparel')Object.assign(fields,{fit:field(index%2?'oversize':'regular','garment shoulder geometry'),silhouette:field('straight','straight garment outline'),sleeves:field('long','visible sleeve length')});
 if(identity.visualGroup==='shoes')Object.assign(fields,{shape:field('chunky','shoe outline'),sole:field('thick','visible sole depth'),closure:field('laces','visible front laces')});
 if(identity.visualGroup==='bag')Object.assign(fields,{size:field('medium','bag scale against model'),carry:field('shoulder','visible shoulder strap'),shape:field('rectangular','rectangular bag outline')});
 if(identity.visualGroup==='accessory')Object.assign(fields,{shape:field('round','accessory outline'),decoration:field('none','plain accessory surface')});
 return fields;
}
export const FIXTURE_TYPE_COUNT=types.length;
