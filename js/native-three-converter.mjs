// Portable Three.js scene analyzer. Does not require DX12 or game-specific
// names. Produces an explicit manifest plus unsupported-feature diagnostics.
// Native renderer support is a separate capability, never implied by export.
export const MANIFEST_VERSION = 1;

function xyz(v){return [v.x,v.y,v.z];}
function color(c){return c?.isColor ? [c.r,c.g,c.b] : null;}
function matrix(m){return Array.from(m.elements);}
function geometryRecord(g,includeData) {
  const data={
    uuid:g.uuid, type:g.type,
    vertexCount:g.getAttribute?.('position')?.count??0,
    indexCount:g.index?.count??0,
    nativeAsset:g.userData?.nativeMesh??null
  };
  if(includeData && !data.nativeAsset) {
    data.attributes={};
    for(const [name,attribute] of Object.entries(g.attributes??{})) {
      if(!attribute?.isBufferAttribute)continue;
      data.attributes[name]={
        itemSize:attribute.itemSize,
        normalized:attribute.normalized,
        values:Array.from(attribute.array)
      };
    }
    data.indices=g.index?Array.from(g.index.array):null;
  }
  return data;
}
function materialRecord(m,issues) {
  if(!m)return null;
  if(!m.isMeshStandardMaterial && !m.isMeshBasicMaterial &&
     !m.isMeshPhysicalMaterial && !m.isMeshLambertMaterial &&
     !m.isMeshPhongMaterial) {
    issues.push({code:'UNSUPPORTED_MATERIAL',name:m.name||m.uuid,detail:m.type});
  }
  const record={
    uuid:m.uuid,name:m.name||'',type:m.type,
    color:color(m.color),opacity:m.opacity??1,
    transparent:!!m.transparent,alphaTest:m.alphaTest??0,
    side:m.side??0,roughness:m.roughness??null,
    metalness:m.metalness??null,emissive:color(m.emissive),
    map:null
  };
  if(m.map){
    const src=m.map.image?.src??m.map.source?.data?.src??null;
    record.map=typeof src==='string'?src:null;
    if(!record.map)issues.push({
      code:'TEXTURE_SOURCE_UNAVAILABLE',name:m.name||m.uuid,
      detail:'Texture requires an imported external image or separate pixel conversion'
    });
  }
  return record;
}
export function convertThreeScene(scene,{includeGeometry=true}={}) {
  if(!scene?.isScene)throw new TypeError('convertThreeScene requires THREE.Scene');
  scene.updateMatrixWorld(true);
  const manifest={format:'NativeThreeManifest',version:MANIFEST_VERSION,
                  objects:[],geometries:[],materials:[],issues:[],counts:{}};
  const objects=new Map(),geometries=new Map(),materials=new Map();
  let nextId=1;
  scene.traverse(obj=>{
    const id=nextId++;
    objects.set(obj,id);
    const type=obj.isSkinnedMesh?'SkinnedMesh':obj.isInstancedMesh?'InstancedMesh':
      obj.isMesh?'Mesh':obj.isSpotLight?'SpotLight':obj.isDirectionalLight?'DirectionalLight':
      obj.isPointLight?'PointLight':obj.isAmbientLight?'AmbientLight':
      obj.isPerspectiveCamera?'PerspectiveCamera':obj.isOrthographicCamera?'OrthographicCamera':
      obj.isGroup?'Group':obj.isScene?'Scene':obj.type;
    const entry={
      id,parent:objects.get(obj.parent)??null,
      name:obj.name||'',type,visible:obj.visible,
      localMatrix:matrix(obj.matrix),worldMatrix:matrix(obj.matrixWorld),
      geometry:null,materials:[]
    };
    if(obj.isMesh){
      const g=obj.geometry;
      if(!g?.isBufferGeometry){
        manifest.issues.push({code:'UNSUPPORTED_GEOMETRY',name:obj.name,detail:g?.type??'none'});
      } else {
        entry.geometry=g.uuid;
        if(!geometries.has(g.uuid)){
          const record=geometryRecord(g,includeGeometry);
          geometries.set(g.uuid,record);
          manifest.geometries.push(record);
        }
        if(!g.getAttribute('position') && !g.userData?.nativeMesh)
          manifest.issues.push({code:'NO_POSITION_OR_ASSET',name:obj.name,detail:g.uuid});
      }
      for(const m of Array.isArray(obj.material)?obj.material:[obj.material]){
        if(!m)continue;
        entry.materials.push(m.uuid);
        if(!materials.has(m.uuid)){
          const record=materialRecord(m,manifest.issues);
          materials.set(m.uuid,record);
          manifest.materials.push(record);
        }
      }
      if(obj.isInstancedMesh){
        entry.instances=obj.count;
        entry.instanceMatrices=Array.from(obj.instanceMatrix.array.subarray(0,obj.count*16));
      }
      if(obj.isSkinnedMesh)
        manifest.issues.push({code:'SKINNING_NOT_NATIVE_YET',name:obj.name,detail:'Requires skeletal animation importer'});
    }
    if(obj.isLight){
      entry.light={
        color:color(obj.color),intensity:obj.intensity,
        distance:obj.distance??null,angle:obj.angle??null,
        penumbra:obj.penumbra??null,castShadow:!!obj.castShadow
      };
    }
    if(obj.isCamera){
      entry.camera={near:obj.near,far:obj.far,zoom:obj.zoom,
        fov:obj.fov??null,left:obj.left??null,right:obj.right??null,
        top:obj.top??null,bottom:obj.bottom??null};
    }
    if(obj.isPoints||obj.isLine||obj.isSprite)
      manifest.issues.push({code:'PRIMITIVE_NOT_NATIVE_YET',name:obj.name,detail:type});
    manifest.objects.push(entry);
    manifest.counts[type]=(manifest.counts[type]??0)+1;
  });
  manifest.compatible=manifest.issues.length===0;
  return manifest;
}
