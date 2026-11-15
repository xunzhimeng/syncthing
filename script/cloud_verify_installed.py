#!/usr/bin/env python3
"""Verify the installed isolated Mac desktop core against the LAN test server.
Reads only the two explicitly named test profiles; never outputs credentials.
"""
import hashlib,json,ssl,time,urllib.request,xml.etree.ElementTree as ET
from pathlib import Path

home=Path.home();client=home/'Library/Application Support/com.xun.cloud.test/core';server=home/'Library/Application Support/XunCloud-TestServer'
report={}
def api(config,ca,path,body=None):
 c=ET.parse(config).getroot();address=c.findtext('gui/address');key=c.findtext('gui/apikey')
 ctx=ssl.create_default_context(cafile=str(ca));op=urllib.request.build_opener(urllib.request.ProxyHandler({}),urllib.request.HTTPSHandler(context=ctx))
 r=urllib.request.Request('https://'+address+'/rest/'+path,data=None if body is None else json.dumps(body).encode(),headers={'X-API-Key':key,'Content-Type':'application/json'})
 with op.open(r,timeout=35)as f:
  data=f.read();return json.loads(data)if data else None

def cli(path,body=None):return api(client/'config.xml',client/'https-ca.pem',path,body)
def srv(path,body=None):return api(server/'config/config.xml',server/'pki/ca.pem',path,body)
def wait(fn,description):
 end=time.monotonic()+70
 while time.monotonic()<end:
  try:
   if fn():return
  except (OSError,urllib.error.URLError):pass
  time.sleep(.5)
 raise AssertionError(description)

wait(lambda:(client/'config.xml').exists(),'desktop did not initialize')
wait(lambda:cli('system/ping')['ping']=='pong','desktop core not ready')
creds=json.loads((server/'test-account.json').read_text())
result=cli('cloud/join',{'server':creds['server'],'username':creds['username'],'password':creds['password']})
path=Path(result['path']);folder=next(f for f in cli('config/folders')if f['path']==str(path))
remote=next(f for f in srv('config/folders')if f['id']==folder['id']);dest=Path(remote['path'])
report['clientFolder']=str(path);report['serverFolder']=str(dest)
wait(lambda:any(v.get('connected')for v in cli('system/connections')['connections'].values()),'BEP did not connect')
name='mac-desktop-check-'+str(time.time_ns())+'.txt';data=('XunCloud Tauri isolated test '+name+'\n').encode()
(path/name).write_bytes(data);cli('db/scan?folder='+folder['id'],{})
wait(lambda:(dest/name).read_bytes()==data,'desktop -> server failed')
reply=name.replace('check','reply');other=b'XunCloud server -> desktop verified\n';(dest/reply).write_bytes(other);srv('db/scan?folder='+folder['id'],{})
wait(lambda:(path/reply).read_bytes()==other,'server -> desktop failed')
report.update({'desktopToServerSHA256':hashlib.sha256(data).hexdigest(),'serverToDesktopSHA256':hashlib.sha256(other).hexdigest(),'bothDirections':True,'file':name,'reply':reply})
(client/'desktop-verification.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(report,indent=2))
