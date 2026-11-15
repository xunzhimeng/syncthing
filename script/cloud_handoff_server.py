#!/usr/bin/env python3
"""Read-only TLS handoff server: serve ONLY a prepared public directory and exact token paths.
No directory listings, symlinks, credentials, remote writes, or HTTP redirects.
"""
import argparse,hmac,http.server,ipaddress,ssl,threading,urllib.parse
from pathlib import Path

def main():
 p=argparse.ArgumentParser();p.add_argument('--root',type=Path,required=True);p.add_argument('--token-file',type=Path,required=True);p.add_argument('--cert',type=Path,required=True);p.add_argument('--key',type=Path,required=True);p.add_argument('--host',required=True);p.add_argument('--port',type=int,default=18444);args=p.parse_args()
 root=args.root.resolve();token=args.token_file.read_text().strip()
 if len(token)<24:raise ValueError('token too short')
 allowed={f.name:f for f in root.iterdir() if f.is_file() and not f.is_symlink()}
 class Handler(http.server.BaseHTTPRequestHandler):
  def log_message(self,*args):pass  # URL contains the download capability.
  def do_GET(self):self.serve(False)
  def do_HEAD(self):self.serve(True)
  def serve(self,head):
   remote=ipaddress.ip_address(self.client_address[0]);local=ipaddress.ip_address(args.host)
   if not (remote.is_loopback or remote in ipaddress.ip_network(str(local)+'/24',strict=False)):
    self.send_error(403);return
   url=urllib.parse.urlsplit(self.path);parts=url.path.split('/')
   if url.query or len(parts)!=3 or not hmac.compare_digest(parts[1],token) or parts[2] not in allowed:
    self.send_error(404);return
   f=allowed[parts[2]]
   if f.is_symlink():self.send_error(404);return
   self.send_response(200);self.send_header('Content-Type','application/octet-stream');self.send_header('Content-Length',str(f.stat().st_size));self.send_header('Cache-Control','no-store');self.send_header('X-Content-Type-Options','nosniff');self.end_headers()
   if not head:
    with f.open('rb') as src:
     while True:
      b=src.read(1<<18)
      if not b:break
      self.wfile.write(b)
 server=http.server.ThreadingHTTPServer((args.host,args.port),Handler)
 ctx=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER);ctx.minimum_version=ssl.TLSVersion.TLSv1_2;ctx.load_cert_chain(args.cert,args.key)
 server.socket=ctx.wrap_socket(server.socket,server_side=True)
 print('TLS handoff ready on %s:%d (%d public files)'%(args.host,args.port,len(allowed)),flush=True)
 timer=threading.Timer(24*3600,server.shutdown);timer.daemon=True;timer.start()
 try:server.serve_forever()
 finally:server.server_close();timer.cancel()
if __name__=='__main__':main()
