#!/bin/bash
set -e
FB=/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf
SS=~/workspace/apps/adpilot/public
DASH=~/workspace/user/media_library/browser_screenshots/d3/d3c5babbeaf8ed08acd38721971d67583e7b6aedcc12fa324a476fc23b1a0202.png

banner() {
  # $1 = step text (colons escaped)
  echo "drawbox=x=0:y=0:w=iw:h=96:color=black@0.62:t=fill,drawtext=fontfile=$FB:text='$1':fontcolor=white:fontsize=40:x=(w-text_w)/2:y=28"
}

mkseg() {
  # $1=out $2=input $3=frames $4=zoompan_params $5=banner_text(optional)
  local vf="scale=2400:1350,zoompan=z='$4':d=$3:x='$6':y='$7':s=1280x720:fps=30"
  echo "building $1..."
}

# Simpler: call ffmpeg directly per segment
F() { # fade in/out
  local dur=$1
  echo "fade=t=in:st=0:d=0.4,fade=t=out:st=$(python3 -c "print($dur - 0.4)"):d=0.4,format=yuv420p"
}

# 1. intro 5.5s
ffmpeg -y -v error -loop 1 -i card_intro.png -vf "scale=1280:720,zoompan=z='1+0.12*on/165':d=165:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1280x720:fps=30,$(F 5.5)" -t 5.5 -c:v libx264 -pix_fmt yuv420p seg1.mp4

# 2. s1 9.5s - zoom to Connect Facebook (top-right)
B1=$(banner "Step 1\: Connect your Facebook Page")
ffmpeg -y -v error -loop 1 -i "$DASH" -vf "scale=2400:1350,zoompan=z='1+0.5*on/285':d=285:x='(iw-iw/zoom)*(0.5+0.22*on/285)':y='(ih-ih/zoom)*(0.5-0.30*on/285)':s=1280x720:fps=30,$B1,$(F 9.5)" -t 9.5 -c:v libx264 -pix_fmt yuv420p seg2.mp4

# 3. s2 8s - zoom to Compose nav (left)
B2=$(banner "Step 2\: Compose your post")
ffmpeg -y -v error -loop 1 -i "$SS/adpilot-ss1-1600x900.png" -vf "scale=2400:1350,zoompan=z='1+0.45*on/240':d=240:x='(iw-iw/zoom)*(0.5-0.36*on/240)':y='(ih-ih/zoom)*(0.5+0.10*on/240)':s=1280x720:fps=30,$B2,$(F 8)" -t 8 -c:v libx264 -pix_fmt yuv420p seg3.mp4

# 4. s3 9s - welcome/stats center
B3=$(banner "Step 3\: Publish or schedule to Facebook & Instagram")
ffmpeg -y -v error -loop 1 -i "$SS/adpilot-ss1-1600x900.png" -vf "scale=2400:1350,zoompan=z='1+0.4*on/270':d=270:x='iw/2-(iw/zoom/2)':y='(ih-ih/zoom)*(0.5+0.06*on/270)':s=1280x720:fps=30,$B3,$(F 9)" -t 9 -c:v libx264 -pix_fmt yuv420p seg4.mp4

# 5. s4 12s - ads manager
B4=$(banner "Step 4\: Create ad campaigns with one click")
ffmpeg -y -v error -loop 1 -i "$SS/adpilot-ss2-1600x900.png" -vf "scale=2400:1350,zoompan=z='1+0.35*on/360':d=360:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1280x720:fps=30,$B4,$(F 12)" -t 12 -c:v libx264 -pix_fmt yuv420p seg5.mp4

# 6. s5 10s - wallet card top
B5=$(banner "Step 5\: Top up your wallet — pay only for what you use")
ffmpeg -y -v error -loop 1 -i "$DASH" -vf "scale=2400:1350,zoompan=z='1+0.5*on/300':d=300:x='iw/2-(iw/zoom/2)':y='(ih-ih/zoom)*(0.5-0.20*on/300)':s=1280x720:fps=30,$B5,$(F 10)" -t 10 -c:v libx264 -pix_fmt yuv420p seg6.mp4

# 7. outro 7s
ffmpeg -y -v error -loop 1 -i card_outro.png -vf "scale=1280:720,zoompan=z='1+0.10*on/210':d=210:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1280x720:fps=30,$(F 7)" -t 7 -c:v libx264 -pix_fmt yuv420p seg7.mp4

echo "ALL SEGMENTS DONE"
ls -la seg*.mp4
