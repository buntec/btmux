# Converting a QuickTime recording to `demo.mp4`

The checked-in demo video is a web-friendly H.264 MP4. To replace it with a
QuickTime screen recording, run the following from the repository root:

```sh
ffmpeg -y \
  -i "Screen Recording YYYY-MM-DD at HH.MM.SS.mov" \
  -vf "scale=1280:-2:flags=lanczos,fps=30" \
  -c:v libx264 \
  -preset medium \
  -crf 23 \
  -pix_fmt yuv420p \
  -movflags +faststart \
  -an \
  demo.mp4
```

Replace the input filename with the actual recording name. The filter scales
the video to 1280 pixels wide while preserving its aspect ratio, chooses an
even height for yuv420p, and reduces high-frame-rate screen captures to 30
fps. The output has no audio.

Verify the result decodes cleanly and has the expected properties:

```sh
ffmpeg -v error -i demo.mp4 -f null -
ffprobe -v error \
  -show_entries format=duration,size:stream=codec_name,width,height,pix_fmt,r_frame_rate \
  -of default=noprint_wrappers=1 demo.mp4
```

`-movflags +faststart` places the MP4 metadata before the media data so the
video can begin playing before the entire file has downloaded.
