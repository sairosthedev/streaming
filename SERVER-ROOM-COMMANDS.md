# Server Room — command sheet (eKHAYAH Ubuntu server)

Cameras: 192.168.89.113, 192.168.89.114, 192.168.89.44 — admin / sibanda#3
Camera network: 192.168.89.0/24 (NO DHCP → static IP needed)

====================================================================
STEP 0 — after boot, log in, go to the code
====================================================================
cd ~/streaming/pc

====================================================================
STEP 1 — confirm .env is in the RIGHT place (repo root, NOT pc/)
====================================================================
ls -la ~/streaming/.env
# If "No such file", it's in pc/ — move it:
#   mv ~/streaming/pc/.env ~/streaming/.env

====================================================================
STEP 2 — get on the camera network (static IP, no DHCP there)
====================================================================
# Find the wired interface name:
ip link
# (look for something like enp3s0 / eth0 — NOT 'lo')

# Set a static IP on it (replace enp3s0 with yours):
sudo ip addr add 192.168.89.10/24 dev enp3s0
sudo ip link set enp3s0 up

# Confirm you can reach a camera:
ping -c 3 192.168.89.113
#   REPLIES  -> good, continue
#   timeout  -> cable not in camera switch, or wrong interface

====================================================================
STEP 3 — start the stream
====================================================================
cd ~/streaming/pc
npm start
# Leave this terminal open. Watch for:
#   "Cameras (3): cam-113 / cam-114 / cam-44"
#   NO repeating "i/o timeout"
# View locally:  http://<this-server-ip>:8080   (password MkyaDe7fXNhwr3sq)

# If it hangs on startup = MongoDB Atlas can't be reached from here.
#   Fix: Atlas -> Network Access -> add this network's public IP (or 0.0.0.0/0).
#   Once it connects ONCE, the offline cache lets it start without internet later.

====================================================================
STEP 4 — put it online (SECOND terminal, leave npm start running)
====================================================================
cd ~/streaming/pc
npm run tunnel
# Live at:  https://camera.titancctv.xyz   (password MkyaDe7fXNhwr3sq)
# Needs internet on this box.

====================================================================
IF MediaMTX is missing ("mediamtx not found")
====================================================================
ls ~/streaming/pc/bin/mediamtx
# If missing and you have internet:
cd ~/streaming/pc && mkdir -p bin
wget --tries=5 --timeout=60 -O mm.tar.gz \
  https://github.com/bluenviron/mediamtx/releases/download/v1.9.3/mediamtx_v1.9.3_linux_amd64.tar.gz
tar -xzf mm.tar.gz -C bin && chmod +x bin/mediamtx

====================================================================
CHECK / RESTART
====================================================================
# Is it serving?  (from the server itself)
curl -s -o /dev/null -w "%{http_code}\n" --max-time 8 \
  "http://localhost:8080/cam-113.mp4?key=wxbtr5kig0uyf2pzvnq68e9js7mc1adhl3o4"
#   200 = video flowing

# Restart the stream: Ctrl+C in the npm start terminal, then:  npm start

====================================================================
SHUT DOWN (proper, safe)
====================================================================
# 1. Stop the stream + tunnel: press Ctrl+C in each terminal
# 2. Then power off the machine cleanly:
sudo shutdown -h now
#   (or schedule: sudo shutdown -h +5   = shut down in 5 min)
#   (cancel a scheduled shutdown: sudo shutdown -c)

# Just reboot instead:
#   sudo reboot
