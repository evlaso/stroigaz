"""Bake a static studio-lit metal variant from the contour's exact geometry.
Usage: ANATOMY_SCENE_EXPORT=/tmp/stroygaz-lit-scenes node scripts/anatomy/build-cases.mjs
       python scripts/anatomy/frame-variants.py cases
       python scripts/anatomy/render-metal.py /tmp/stroygaz-lit-scenes/cip.json
No floor plane or external shadow. Depth, smooth cylinder normals, area-light
visibility and GGX specular are evaluated on the same mesh as the SVG.
"""
from pathlib import Path
import json,sys,re
import numpy as np
from PIL import Image,ImageFilter,ImageChops

scene=json.loads(Path(sys.argv[1]).read_text())
V=np.asarray(scene['toward'],dtype=np.float64)
normalize=lambda a:a/np.maximum(np.linalg.norm(a,axis=-1,keepdims=True),1e-10)
triangles=[]
materials={'steel':0,'frame':1,'graphite':2}
# Pipework is physical tube geometry, not a line overlay. Silhouette strokes
# and cabinet seams are deliberately excluded from these routed segments.
for route in scene.get('routes',[]):
    for a,b in zip(route,route[1:]):
        a=np.asarray(a,float);b=np.asarray(b,float);axis=normalize(b-a)
        guide=np.array([0.,0.,1.]) if abs(axis[2])<.9 else np.array([1.,0.,0.])
        u=normalize(np.cross(axis,guide));v=np.cross(axis,u)
        ns=np.array([np.cos(t)*u+np.sin(t)*v for t in np.linspace(0,2*np.pi,16,endpoint=False)])
        rings=[a+ns*.95,b+ns*.95]
        for i in range(16):
            j=(i+1)%16
            scene['surfaces'].append({'pts':[rings[0][i],rings[0][j],rings[1][j],rings[1][i]],
                                     'normals':[ns[i],ns[j],ns[j],ns[i]],'material':'steel'})
for face in scene['surfaces']:
    pts=np.asarray(face['pts'],float)
    n=np.cross(pts[1]-pts[0],pts[2]-pts[0]);n=normalize(n)
    if np.dot(n,V)<0:n=-n
    normals=np.asarray(face.get('normals',[n]*len(pts)),float)
    for i in range(1,len(pts)-1):
        triangles.append((pts[[0,i,i+1]],normals[[0,i,i+1]],materials[face['material']]))

line=Path(scene.get('linePath','src/assets/cases/sampling-schematic.svg'))
vx,vy,vw,vh=map(float,re.search(r'viewBox="([^"]+)"',line.read_text())[1].split())
width=1600;height=round(width*vh/vw);scale=width/vw
axes=np.asarray(scene['axes']).T;origin=np.asarray(scene['origin'])

def raster(project,depth,size,attributes=False):
    w,h=size
    z=np.full((h,w),-np.inf,dtype=np.float32)
    if attributes:
        pos=np.zeros((h,w,3),np.float32);normal=pos.copy();mat=np.zeros((h,w),np.uint8)
    for points,normals,material in triangles:
        p=project(points);ds=points@depth
        lo=np.maximum(np.floor(p.min(axis=0)).astype(int),0);hi=np.minimum(np.ceil(p.max(axis=0)).astype(int),[w-1,h-1])
        if np.any(hi<lo):continue
        yy,xx=np.mgrid[lo[1]:hi[1]+1,lo[0]:hi[0]+1];xx=xx+.5;yy=yy+.5
        a,b,c=p;den=(b[1]-c[1])*(a[0]-c[0])+(c[0]-b[0])*(a[1]-c[1])
        if abs(den)<1e-9:continue
        u=((b[1]-c[1])*(xx-c[0])+(c[0]-b[0])*(yy-c[1]))/den
        v=((c[1]-a[1])*(xx-c[0])+(a[0]-c[0])*(yy-c[1]))/den
        t=1-u-v;d=u*ds[0]+v*ds[1]+t*ds[2]
        sl=np.s_[lo[1]:hi[1]+1,lo[0]:hi[0]+1]
        mask=(u>=-1e-7)&(v>=-1e-7)&(t>=-1e-7)&(d>z[sl]+1e-5)
        z[sl][mask]=d[mask]
        if attributes:
            bary=np.stack([u,v,t],axis=-1)
            pos[sl][mask]=(bary@points)[mask]
            normal[sl][mask]=(bary@normals)[mask]
            mat[sl][mask]=material
    return (z,pos,normalize(normal),mat) if attributes else z

def camera(points):return ((points@axes.T+origin)-[vx,vy])*scale
z,pos,N,mat=raster(camera,V,(width,height),True)
mask=np.isfinite(z);P=pos[mask].astype(float);N=N[mask].astype(float);ids=mat[mask]
N=np.where((N@V<0)[:,None],-N,N)
# Three nearby directional sources approximate one broad studio softbox.
key=normalize(np.array([-.65,.45,1.1]));allpoints=np.concatenate([t[0] for t in triangles])
visibility=np.zeros(len(P))
for offset in [(-.1,-.05),(.1,-.05),(0,.1)]:
    L=normalize(key+np.array([*offset,0]))
    U=normalize(np.cross([0,0,1],L));W=np.cross(L,U)
    basis=np.stack([U,W],axis=1)
    projected=allpoints@basis;lo=projected.min(axis=0)-5;hi=projected.max(axis=0)+5
    factor=1100/max(hi-lo);size=np.ceil((hi-lo)*factor).astype(int)+2
    def project(points):return (points@basis-lo)*factor
    shadow=raster(project,L,tuple(size))
    uv=np.clip(np.floor(project(P)).astype(int),0,size-1)
    nearest=shadow[uv[:,1],uv[:,0]]
    visibility+=(P@L>=nearest-2.0)/3

# Filter the finite emitter visibility to remove shadow-map stair steps.
visibility_image=np.ones((height,width),np.float32)
visibility_image[mask]=visibility
visibility_image=Image.fromarray((visibility_image*255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(7))
visibility=np.asarray(visibility_image,dtype=float)[mask]/255
# GGX microfacet reflection, with a broad highlight from a finite softbox.
light_position=np.array([-170,210,330.])
L=normalize(light_position-P);H=normalize(L+V)
NV=np.clip(N@V,.001,1);NL=np.clip(np.sum(N*L,axis=1),0,1)
NH=np.clip(np.sum(N*H,axis=1),0,1);VH=np.clip(H@V,0,1)
rough=np.take([.29,.34,.44],ids);alpha=rough**2
D=alpha**2/(np.pi*(NH**2*(alpha**2-1)+1)**2)
k=(rough+1)**2/8
G=(NV/(NV*(1-k)+k))*(NL/(NL*(1-k)+k+1e-8))
F0=np.take([.64,.52,.23],ids);F=F0+(1-F0)*(1-VH)**5
spec=D*G*F/np.maximum(4*NV*NL,1e-5)
# Room reflection varies over a curved normal and across broad planar faces.
R=2*NV[:,None]*N-V
strip=np.exp(-((R[:,0]+.45)/.3)**2)*(.35+.65*np.clip(R[:,2],0,1))
window=np.maximum(np.sum(R*normalize(np.array([.8,-.3,.9])),axis=1),0)**18
room=.2+.24*np.clip(R[:,2],0,1)+.38*strip+.28*window
albedo=np.take([.82,.65,.32],ids)
illum=albedo*(room+.18*NL)+np.minimum(spec,2.5)*NL*visibility*2.6
# Physical contact shadow only on the receiving metal, never outside its mask.
# Neighbour displacement toward the visible normal darkens recesses and joints.
normal_buffer=np.zeros_like(pos);normal_buffer[mask]=N
occlusion=np.zeros((height,width),np.float32);samples=0
for radius in [7,18,38]:
    for angle in np.linspace(0,2*np.pi,8,endpoint=False):
        dx=round(np.cos(angle)*radius);dy=round(np.sin(angle)*radius)
        neighbor=np.roll(pos,(dy,dx),(0,1));valid=np.roll(mask,(dy,dx),(0,1))&mask
        if dy>0:valid[:dy]=False
        elif dy<0:valid[dy:]=False
        if dx>0:valid[:,:dx]=False
        elif dx<0:valid[:,dx:]=False
        delta=neighbor-pos;distance=np.linalg.norm(delta,axis=-1)
        toward=np.sum(delta*normal_buffer,axis=-1)/np.maximum(distance,1e-5)
        contribution=np.clip((toward-.08)*2,0,1)*np.exp(-distance/10)*valid
        occlusion+=contribution;samples+=1
ao_full=np.ones((height,width),np.float32)
ao_full[mask]=np.clip(1-occlusion[mask]/samples*2.8,.6,1)
ao_image=Image.fromarray((ao_full*255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(2))
AO=np.asarray(ao_image,dtype=float)[mask]/255
illum*=AO*(.78+.22*visibility)
# Neutral steel; tiny cool reflection in the shadow, no site-brand tint.
linear=illum[:,None]*np.array([.98,1.,1.025])
# ACES filmic tone mapping and display transfer.
a,b,c,d,e=2.51,.03,2.43,.59,.14
rgb=np.clip((linear*(a*linear+b))/(linear*(c*linear+d)+e),0,1)**(1/2.2)
rgba=np.zeros((height,width,4),np.uint8);rgba[mask,:3]=(rgb*255).astype(np.uint8);rgba[mask,3]=255
image=Image.fromarray(rgba)
image=image.resize((1200,round(1200*vh/vw)),Image.Resampling.LANCZOS)
# Keep just the external silhouette, at the contour drawing's visual weight.
# Alpha erosion follows all visible outside edges without outlining parts.
alpha=image.getchannel('A')
inside=alpha.filter(ImageFilter.MinFilter(3))
outline=ImageChops.subtract(alpha,inside)
ink=Image.new('RGBA',image.size,(56,62,67,0))
ink.putalpha(outline.point(lambda v:round(v*.9)))
image=Image.alpha_composite(image,ink)
output=Path(str(line).replace('-schematic.svg','-lit.webp'))
image.save(output,quality=94,method=6)
image.save('/tmp/stroygaz-'+output.stem+'.png')
print(f'Rendered {output}: studio light, GGX steel, smooth cylinders, contact shading')
