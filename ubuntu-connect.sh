#!/bin/bash
# One-shot setup: WiFi + cloudflared. Edit the two WiFi lines below, then run:
#   bash ubuntu-connect.sh

# ===== EDIT THESE TWO LINES =====
WIFI_NAME="YOUR_WIFI_NAME"
WIFI_PASS="YOUR_WIFI_PASSWORD"
# ================================

echo "== Bringing up WiFi =="
sudo ip link set wlo1 up || true
sudo pkill wpa_supplicant 2>/dev/null || true
sleep 1
sudo bash -c "wpa_passphrase \"$WIFI_NAME\" \"$WIFI_PASS\" > /etc/wpa_supplicant.conf"
sudo wpa_supplicant -B -i wlo1 -c /etc/wpa_supplicant.conf
sleep 6
sudo dhclient wlo1 2>/dev/null || sudo dhcpcd wlo1 2>/dev/null || true
sleep 3

echo "== Testing internet =="
if ping -c 3 8.8.8.8 >/dev/null 2>&1; then
  echo "INTERNET: OK"
else
  echo "INTERNET: FAILED - check WiFi name/password"
  exit 1
fi

echo "== Installing cloudflared =="
sudo mkdir -p /usr/share/keyrings
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt update
sudo apt install -y cloudflared
cloudflared --version

echo ""
echo "== DONE =="
echo "WiFi connected, cloudflared installed."
echo "Next: copy ~/.cloudflared credentials from Windows, then:"
echo "  cd ~/streaming/pc && npm start          (terminal 1)"
echo "  cd ~/streaming/pc && npm run tunnel     (terminal 2)"
