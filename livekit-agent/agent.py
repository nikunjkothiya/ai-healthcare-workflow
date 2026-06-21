import logging
import asyncio
import os
import json
import requests
import wave
import io
from livekit.agents import JobContext, WorkerOptions, AutoSubscribe, cli, NOT_GIVEN, NotGivenOr, APIConnectOptions, DEFAULT_API_CONNECT_OPTIONS
from livekit.agents.voice import Agent, AgentSession
from livekit.plugins import openai
from livekit.agents import stt, tts
from livekit.agents.utils import AudioBuffer

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("voice-agent")

class LocalWhisperSTT(stt.STT):
    """
    Custom STT plugin that forwards audio buffers to the local Whisper container
    running on port 9000.
    """
    def __init__(self, host="whisper", port=9000):
        super().__init__(capabilities=stt.STTCapabilities(streaming=False))
        self.url = f"http://{host}:{port}/inference"

    async def _recognize_impl(
        self,
        buffer: AudioBuffer,
        *,
        language: NotGivenOr[str] = NOT_GIVEN,
        conn_options: APIConnectOptions = DEFAULT_API_CONNECT_OPTIONS
    ) -> stt.SpeechEvent:
        logger.info("Transcribing user speech chunk via local Whisper...")
        
        # Merge all audio frames into a single raw PCM byte block
        frames = list(buffer) if isinstance(buffer, list) else [buffer]
        if not frames:
            return stt.SpeechEvent(
                type=stt.SpeechEventType.FINAL_TRANSCRIPT,
                request_id="whisper_stt",
                alternatives=[stt.SpeechData(text="", language="en", start_time=0.0, end_time=0.0, confidence=1.0)]
            )

        raw_pcm = b"".join([bytes(f.data) for f in frames])
        sample_rate = frames[0].sample_rate
        num_channels = frames[0].num_channels

        # Convert raw PCM data to WAV in-memory
        wav_buf = io.BytesIO()
        with wave.open(wav_buf, "wb") as wav_file:
            wav_file.setnchannels(num_channels)
            wav_file.setsampwidth(2)  # 16-bit PCM (2 bytes)
            wav_file.setframerate(sample_rate)
            wav_file.writeframes(raw_pcm)
        
        wav_buf.seek(0)
        
        # Send payload to local whisper endpoint
        files = {"file": ("audio.wav", wav_buf, "audio/wav")}
        data = {"response_format": "json", "temperature": "0.0"}
        
        loop = asyncio.get_event_loop()
        try:
            response = await loop.run_in_executor(
                None, 
                lambda: requests.post(self.url, files=files, data=data, timeout=10)
            )
            if response.status_code == 200:
                result = response.json()
                text = result.get("text", "").strip()
                logger.info(f"Local STT Output: \"{text}\"")
                return stt.SpeechEvent(
                    type=stt.SpeechEventType.FINAL_TRANSCRIPT,
                    request_id="whisper_stt",
                    alternatives=[stt.SpeechData(text=text, language="en", start_time=0.0, end_time=0.0, confidence=1.0)]
                )
        except Exception as e:
            logger.error(f"Whisper STT HTTP request failed: {e}")
            
        return stt.SpeechEvent(
            type=stt.SpeechEventType.FINAL_TRANSCRIPT,
            request_id="whisper_stt",
            alternatives=[stt.SpeechData(text="", language="en", start_time=0.0, end_time=0.0, confidence=1.0)]
        )

class LocalKokoroTTS(tts.TTS):
    """
    Custom TTS plugin that forwards text phrases to the local Kokoro container
    running on port 8880.
    """
    def __init__(self, host="kokoro", port=8880, voice="af_bella"):
        super().__init__(
            capabilities=tts.TTSCapabilities(streaming=False),
            sample_rate=24000,
            num_channels=1
        )
        self.url = f"http://{host}:{port}/v1/audio/speech"
        self.voice = voice

    def synthesize(
        self, text: str, *, conn_options: APIConnectOptions = DEFAULT_API_CONNECT_OPTIONS
    ) -> tts.ChunkedStream:
        return KokoroChunkedStream(tts=self, text=text, conn_options=conn_options)

def apply_telephone_fft_filter(pcm_data: bytes, sample_rate: int = 24000) -> bytes:
    """
    Applies an FFT-based bandpass filter (300Hz - 3400Hz) to simulate a real telephone line.
    Vectorized and highly efficient on CPU.
    """
    import numpy as np
    audio = np.frombuffer(pcm_data, dtype=np.int16).astype(np.float32)
    n = len(audio)
    if n == 0:
        return pcm_data
        
    freqs = np.fft.rfftfreq(n, d=1.0/sample_rate)
    fft_vals = np.fft.rfft(audio)
    
    # Telephone frequency range: 300Hz - 3400Hz
    mask = (freqs >= 300) & (freqs <= 3400)
    fft_vals[~mask] = 0.0
    
    filtered = np.fft.irfft(fft_vals, n)
    return np.clip(filtered, -32768.0, 32767.0).astype(np.int16).tobytes()

class KokoroChunkedStream(tts.ChunkedStream):
    def __init__(self, *, tts: LocalKokoroTTS, text: str, conn_options: APIConnectOptions):
        super().__init__(tts=tts, input_text=text, conn_options=conn_options)
        self.tts_ref = tts

    async def _run(self, output_emitter: tts.AudioEmitter) -> None:
        import re
        import aiohttp
        
        raw_text = self.input_text
        
        # Clean markdown formatting characters
        cleaned_text = raw_text.replace("**", "").replace("*", "").replace("__", "").replace("_", "")
        cleaned_text = re.sub(r"#+\s+", "", cleaned_text).strip()
        
        # Parse paralinguistic pause markers like [pause] or [sigh] or [gasp]
        segments = re.split(r"(\[[^\]]+\])", cleaned_text)
        
        async with aiohttp.ClientSession() as session:
            for segment in segments:
                segment = segment.strip()
                if not segment:
                    continue
                
                # If it's a bracketed tag, inject a natural pause (silence)
                if segment.startswith("[") and segment.endswith("]"):
                    tag = segment[1:-1].lower()
                    pause_duration = 0.6  # Default 600ms pause
                    if "sigh" in tag or "gasp" in tag:
                        pause_duration = 0.8
                    elif "cough" in tag or "throat" in tag:
                        pause_duration = 1.0
                    
                    logger.info(f"Injecting paralinguistic pause for '{segment}' ({pause_duration}s)")
                    # 24000Hz * 2 bytes/sample (16-bit) = 48000 bytes/sec
                    silence_bytes = b"\x00" * int(24000 * 2 * pause_duration)
                    output_emitter.push(silence_bytes)
                    continue
                
                # Otherwise, synthesize speech via local Kokoro container using async HTTP
                logger.info(f"Synthesizing speech via local Kokoro: \"{segment}\"")
                payload = {
                    "model": "kokoro",
                    "input": segment,
                    "voice": self.tts_ref.voice,
                    "response_format": "wav",
                    "speed": 1.0
                }
                
                try:
                    async with session.post(self.tts_ref.url, json=payload, timeout=15) as response:
                        if response.status == 200:
                            audio_bytes = await response.read()
                            wav_buf = io.BytesIO(audio_bytes)
                            with wave.open(wav_buf, "rb") as wav_file:
                                sample_rate = wav_file.getframerate()
                                num_channels = wav_file.getnchannels()
                                pcm_data = wav_file.readframes(wav_file.getnframes())
                            
                            # Apply the telephone simulation filter
                            filtered_pcm = apply_telephone_fft_filter(pcm_data, sample_rate)
                            
                            logger.info(f"Kokoro TTS Success ({len(filtered_pcm)} pcm bytes, {sample_rate}Hz)")
                            output_emitter.push(filtered_pcm)
                        else:
                            logger.error(f"Kokoro HTTP error: {response.status}")
                except Exception as e:
                    logger.error(f"Kokoro TTS HTTP request failed: {e}")

async def entrypoint(ctx: JobContext):
    logger.info(f"LiveKit room detected: {ctx.room.name}. Initializing Voice Agent...")
    
    # Room name format: call_<callId>
    call_id = ctx.room.name.split("_")[-1] if "_" in ctx.room.name else None
    logger.info(f"Parsed call ID: {call_id}")
    
    # Connect LLM stage to OpenRouter free Gemma-4 endpoint
    llm = openai.LLM(
        base_url="https://openrouter.ai/api/v1",
        api_key=os.environ.get("OPENROUTER_API_KEY"),
        model="google/gemma-4-31b-it:free"
    )
    
    # Load custom local STT & TTS classes
    stt_service = LocalWhisperSTT(
        host=os.environ.get("WHISPER_HOST", "whisper"),
        port=int(os.environ.get("WHISPER_PORT", 9000))
    )
    
    tts_service = LocalKokoroTTS(
        host=os.environ.get("KOKORO_HOST", "kokoro"),
        port=int(os.environ.get("KOKORO_PORT", 8880))
    )
    
    # Instantiate the agent
    agent = Agent(
        instructions=(
            "You are an empathetic, brief, and professional AI outreach assistant calling from Medcare Services.\n"
            "Your objective is to confirm the patient's appointment details (e.g. Dr. Chen, March 16th).\n"
            "Keep your responses friendly, warm, and very concise (maximum 1-2 sentences per response).\n"
            "Do not output any markdown formatting.\n"
            "To sound natural, you may optionally include paralinguistic tags like [pause], [sigh], [gasp], or [clear throat] in your text when transitioning thoughts."
        ),
        chat_ctx=openai.ChatContext(),
        stt=stt_service,
        llm=llm,
        tts=tts_service
    )
    
    # Helper to publish JSON events over WebRTC data channel
    async def publish_event(data_dict):
        try:
            payload = json.dumps(data_dict).encode("utf-8")
            await ctx.room.local_participant.publish_data(payload)
        except Exception as e:
            logger.error(f"Failed to publish data channel event: {e}")

    # Start the session (session.start handles room connection automatically)
    session = AgentSession(
        stt=stt_service,
        llm=llm,
        tts=tts_service
    )
    await session.start(agent=agent, room=ctx.room)
    logger.info("Agent session started in room.")
    
    # Store chat history
    transcript = []
    
    # Event listeners on the session instance
    @session.on("user_state_changed")
    async def on_user_state_changed(event):
        logger.info(f"User state changed to {event.new_state}")
        if event.new_state == "speaking":
            await publish_event({"type": "state", "value": "user_speaking"})
        elif event.new_state == "listening":
            await publish_event({"type": "state", "value": "listening"})
            
    @session.on("agent_state_changed")
    async def on_agent_state_changed(event):
        logger.info(f"Agent state changed to {event.new_state}")
        if event.new_state == "speaking":
            await publish_event({"type": "state", "value": "agent_speaking"})
        elif event.new_state == "listening" or event.new_state == "idle":
            await publish_event({"type": "state", "value": "listening"})
            
    @session.on("user_input_transcribed")
    async def on_user_input_transcribed(event):
        if event.is_final and event.transcript:
            logger.info(f"Patient says: {event.transcript}")
            transcript.append(f"Patient: {event.transcript}")
            await publish_event({
                "type": "transcript",
                "role": "user",
                "text": event.transcript
            })
            
    @session.on("conversation_item_added")
    async def on_conversation_item_added(event):
        item = event.item
        if item.role == "assistant":
            content_str = ""
            if isinstance(item.content, str):
                content_str = item.content
            elif isinstance(item.content, list):
                content_str = "".join([c for c in item.content if isinstance(c, str)])
            if content_str:
                logger.info(f"Assistant says: {content_str}")
                transcript.append(f"Assistant: {content_str}")
                await publish_event({
                    "type": "transcript",
                    "role": "assistant",
                    "text": content_str
                })
                await publish_event({"type": "state", "value": "listening"})

    # Wait for the participant (patient) to connect
    logger.info("Waiting for patient to connect to room...")
    participant = await ctx.wait_for_participant()
    logger.info(f"Patient connected: {participant.identity}. Initiating call...")
    
    # Speak first with greeting
    await session.say("Hello, I'm calling from Medcare services regarding your appointment booking. Is this nice time to talk with you?", allow_interruptions=True)

    # Keep connection open until user disconnects
    while ctx.room.is_connected:
        await asyncio.sleep(1)
        
    logger.info(f"WebRTC call room {ctx.room.name} closed. Syncing transcript back to backend...")
    
    # If we have a call ID and generated transcripts, sync back to backend DB
    if call_id and transcript:
        full_transcript = "\n".join(transcript).strip()
        backend_url = os.environ.get("BACKEND_URL", "http://backend:4000")
        try:
            loop = asyncio.get_event_loop()
            res = await loop.run_in_executor(
                None,
                lambda: requests.post(
                    f"{backend_url}/patients/public/livekit/calls/{call_id}/complete",
                    json={"transcript": full_transcript},
                    timeout=8
                )
            )
            logger.info(f"Backend sync response status: {res.status_code}")
        except Exception as e:
            logger.error(f"Failed to sync call transcript to backend: {e}")

if __name__ == "__main__":
    cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint))
