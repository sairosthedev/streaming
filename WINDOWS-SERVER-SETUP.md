# Windows 10 Server Setup — eKHAYAH streaming (auto-start on boot)

Do these AFTER Windows 10 is installed. Goal: server + tunnel run automatically
on every boot, no login, no terminal window. Uses NSSM (a service wrapper).

Cameras: 192.168.89.113 / .114 / .44 — admin / sibanda#3
Tunnel: titan-camera -> https://camera.titancctv.xyz (already configured)

====================================================================
PART 1 — Install the software (needs internet)
====================================================================
Open PowerShell as Administrator (right-click Start > Windows PowerShell (Admin))

# Node.js LTS, Git, ffmpeg, cloudflared, NSSM — all via winget
winget install OpenJS.NodeJS.LTS
winget install Git.Git
winget install Gyan.FFmpeg
winget install Cloudflare.cloudflared
winget install NSSM.NSSM

# CLOSE and REOPEN PowerShell (so PATH updates), then verify:
node --version
git --version
ffmpeg -version
cloudflared --version

====================================================================
PART 2 — Get the code + secrets
====================================================================
cd C:\
git clone https://github.com/sairosthedev/streaming
cd streaming\pc
npm install
npm run setup            # downloads MediaMTX for Windows

# .env is NOT in git. Copy it to the repo ROOT: C:\streaming\.env
#   (from your laptop:  scp .env user@thispc:C:/streaming/.env
#    or just create it by hand — contents are in the private notes)

# cloudflared credentials: copy from your laptop's C:\Users\macdo\.cloudflared
#   to  C:\Users\<thisuser>\.cloudflared   (whole folder)
# Verify:
cloudflared tunnel list          # should show titan-camera

====================================================================
PART 3 — Network: static IP on the camera network
====================================================================
# The camera switch has NO DHCP. Set a static IP.
# Find your adapter name:
Get-NetAdapter

# Set static IP (replace "Ethernet" with your adapter name):
netsh interface ip set address name="Ethernet" static 192.168.89.55 255.255.255.0

# Test camera reachability:
ping 192.168.89.113
#   >>> MUST be steady 0% loss. If it flickers/times out, the CABLE is bad -
#       replace it with a good Cat6 into the main switch. This is the #1 issue.

====================================================================
PART 4 — Test it runs manually first
====================================================================
cd C:\streaming\pc
npm start
#   Should list cam-113 / cam-114 / cam-44 and "Local: http://localhost:8080"
#   Open http://localhost:8080 (password MkyaDe7fXNhwr3sq)
#   Ctrl+C to stop once you confirm it works.

====================================================================
PART 5 — Auto-start on boot (NSSM services)
====================================================================
# Run PowerShell as Administrator.
# Find your node.exe path:
(Get-Command node).Source
#   e.g. C:\Program Files\nodejs\node.exe  -- use YOUR path below.

# --- Service 1: the streaming server ---
nssm install TitanCamera "C:\Program Files\nodejs\node.exe" "src\webrtc.js"
nssm set TitanCamera AppDirectory "C:\streaming\pc"
nssm set TitanCamera Start SERVICE_AUTO_START
nssm set TitanCamera AppStdout "C:\streaming\pc\service-camera.log"
nssm set TitanCamera AppStderr "C:\streaming\pc\service-camera.log"
nssm set TitanCamera AppRestartDelay 5000

# --- Service 2: the tunnel ---
nssm install TitanTunnel "C:\Program Files\nodejs\node.exe" "src\tunnel.js"
nssm set TitanTunnel AppDirectory "C:\streaming\pc"
nssm set TitanTunnel Start SERVICE_AUTO_START
nssm set TitanTunnel AppStdout "C:\streaming\pc\service-tunnel.log"
nssm set TitanTunnel AppStderr "C:\streaming\pc\service-tunnel.log"
nssm set TitanTunnel DependOnService TitanCamera
nssm set TitanTunnel AppRestartDelay 10000

# Start both now:
nssm start TitanCamera
nssm start TitanTunnel

# Confirm:
nssm status TitanCamera
nssm status TitanTunnel
#   both should say SERVICE_RUNNING

====================================================================
PART 6 — Verify online
====================================================================
# Local:   http://localhost:8080
# Online:  https://camera.titancctv.xyz   (password MkyaDe7fXNhwr3sq)
# Reboot the PC — both services should come back automatically, no login.

====================================================================
MANAGING THE SERVICES
====================================================================
nssm restart TitanCamera        # after changing cameras
nssm restart TitanTunnel
nssm stop TitanCamera
nssm status TitanCamera
# View logs:
Get-Content C:\streaming\pc\service-camera.log -Tail 30
Get-Content C:\streaming\pc\service-tunnel.log -Tail 30
# Remove a service (if needed):
nssm remove TitanCamera confirm

====================================================================
POWER SETTINGS (important for an always-on server)
====================================================================
# Stop the PC sleeping / turning off the network:
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
powercfg /change monitor-timeout-ac 15
# In Device Manager > network adapter > Power Management:
#   uncheck "Allow the computer to turn off this device to save power"

====================================================================
THE ONE THING THAT STILL MATTERS MOST
====================================================================
The camera cable must give STEADY 0% packet loss. Windows does not fix the
flickering 100Mb link - that is a physical cable/port fault. Get a good Cat6
cable into a gigabit port on the main managed switch. Without that, cameras
time out on Windows exactly as they did on Ubuntu.
