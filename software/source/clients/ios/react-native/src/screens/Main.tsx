import React, { useState, useEffect, useCallback } from "react";
import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import * as FileSystem from 'expo-file-system';
import { AVPlaybackStatus, AVPlaybackStatusSuccess, Audio } from "expo-av";
import { polyfill as polyfillEncoding } from 'react-native-polyfill-globals/src/encoding';

interface MainProps {
  route: {
    params: {
      scannedData: string;
    };
  };
}

const Main: React.FC<MainProps> = ({ route }) => {
  const { scannedData } = route.params;
  const [connectionStatus, setConnectionStatus] = useState<string>("Connecting...");
  const [ws, setWs] = useState<WebSocket | null>(null);
  const [recording, setRecording] = useState<Audio.Recording | null>(null);
  const [audioQueue, setAudioQueue] = useState<string[]>([]);
  const [sound, setSound] = useState<Audio.Sound | null>();
  const audioDir = FileSystem.documentDirectory + '01/audio/';
  const [permissionResponse, requestPermission] = Audio.usePermissions();
  polyfillEncoding();
  const reader = new FileReader();

    const constructTempFilePath = async (buffer: string) => {
      await dirExists();
      const tempFilePath = `${audioDir}${Date.now()}.wav`;


        await FileSystem.writeAsStringAsync(
          tempFilePath,
          buffer,
          {
            encoding: FileSystem.EncodingType.Base64,
          }
        );


      return tempFilePath;
    };


  async function dirExists() {
    /**
     * Checks if audio directory exists in device storage, if not creates it.
     */
    const dirInfo = await FileSystem.getInfoAsync(audioDir);
    if (!dirInfo.exists) {
      console.log("audio directory doesn't exist, creating...");
      await FileSystem.makeDirectoryAsync(audioDir, { intermediates: true });
    }
  }

  const playNextAudio = async () => {
    console.log("in playNextAudio audioQueue is", audioQueue.length);

    if (sound != null){
      console.log('Unloading Sound');
      await sound.unloadAsync();
      setSound(null);
    }

    if (audioQueue.length > 0) {
      const uri = audioQueue.shift() as string;
      console.log("load audio from", uri);

      try {
        const { sound } = await Audio.Sound.createAsync({ uri });
        setSound(sound);

        console.log("playing audio from", uri);
        await sound?.playAsync();

        sound.setOnPlaybackStatusUpdate(_onPlayBackStatusUpdate);

      } catch (error){
        console.log("Error playing audio", error);
        playNextAudio();
      }

    }
  };

  const isAVPlaybackStatusSuccess = (
    status: AVPlaybackStatus
  ): status is AVPlaybackStatusSuccess => {
    return (status as AVPlaybackStatusSuccess).isLoaded !== undefined;
  };

  const _onPlayBackStatusUpdate = (status: AVPlaybackStatus) => {
    if (isAVPlaybackStatusSuccess(status) && status.didJustFinish){
      playNextAudio();
    }
  }

  useEffect(() => {
    console.log("audioQueue has been updated:", audioQueue.length);
    if (audioQueue.length == 1) {
      playNextAudio();
    }
  }, [audioQueue]);

  useEffect(() => {
    let websocket: WebSocket;
    try {
      console.log("Connecting to WebSocket at " + scannedData);
      websocket = new WebSocket(scannedData);
      websocket.binaryType = "blob";

      websocket.onopen = () => {
        setConnectionStatus(`Connected to ${scannedData}`);
        console.log("WebSocket connected");
      };

      websocket.onmessage = async (e) => {

        const message = JSON.parse(e.data);
        console.log(message.content.slice(0, 50));

        const buffer = await message.content as string;
        const filePath = await constructTempFilePath(buffer);
        setAudioQueue((prevQueue) => [...prevQueue, filePath]);
        console.log("audio file written to", filePath);

        if (message.format === "bytes.raw" && message.end && audioQueue.length >= 1) {
          console.log("calling playNextAudio");
          playNextAudio();
        }
      };

      websocket.onerror = (error) => {
        setConnectionStatus("Error connecting to WebSocket.");
        console.error("WebSocket error: ", error);
      };

      websocket.onclose = () => {
        setConnectionStatus("Disconnected.");
        console.log("WebSocket disconnected");
      };

      setWs(websocket);
    } catch (error) {
      console.log(error);
      setConnectionStatus("Error creating WebSocket.");
    }

    return () => {
      if (websocket) {
        websocket.close();
      }
    };
  }, [scannedData]);

  const startRecording = useCallback(async () => {
    if (recording) {
      console.log("A recording is already in progress.");
      return;
    }

    try {
      if (permissionResponse !== null && permissionResponse.status !== `granted`) {
        console.log("Requesting permission..");
        await requestPermission();
      }

      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
      });

      console.log("Starting recording..");
      const newRecording = new Audio.Recording();
      await newRecording.prepareToRecordAsync(Audio.RecordingOptionsPresets.HIGH_QUALITY);
      await newRecording.startAsync();

      setRecording(newRecording);
    } catch (err) {
      console.error("Failed to start recording", err);
    }
  }, []);

  const stopRecording = useCallback(async () => {
    console.log("Stopping recording..");

    if (recording) {
      await recording.stopAndUnloadAsync();
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: false,
      });
      const uri = recording.getURI();
      console.log("recording uri at ", uri);
      setRecording(null);

      // sanity check play the audio recording locally
      // recording is working fine; is the server caching the audio file somewhere?
      /**
      if (uri) {
        const { sound } = await Audio.Sound.createAsync({ uri });
        sound.playAsync();
        console.log("playing audio recording from", uri);
      }
       */


      if (ws && uri) {
        const response = await fetch(uri);
        console.log("fetched audio file", response);
        const blob = await response.blob();

        reader.readAsArrayBuffer(blob);
        reader.onloadend = () => {
          const audioBytes = reader.result;
          if (audioBytes) {
            ws.send(audioBytes);
            const audioArray = new Uint8Array(audioBytes as ArrayBuffer);
            const decoder = new TextDecoder("utf-8");
            console.log("sent audio bytes to WebSocket", decoder.decode(audioArray).slice(0, 50));
          }
        };
      }

    }
  }, [recording]);

  return (
    <View style={styles.container}>
      <Text
        style={[
          styles.statusText,
          { color: connectionStatus.startsWith("Connected") ? "green" : "red" },
        ]}
      >
        {connectionStatus}
      </Text>
      <TouchableOpacity
        style={styles.button}
        onPressIn={startRecording}
        onPressOut={stopRecording}
      >
        <View style={styles.circle}>
          <Text style={styles.buttonText}>Record</Text>
        </View>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: "center",
    backgroundColor: '#ecf0f1',
    padding: 10,
  },
  circle: {
    width: 100,
    height: 100,
    borderRadius: 50,
    backgroundColor: "black",
    justifyContent: "center",
    alignItems: "center",
  },
  button: {
    width: 100,
    height: 100,
    borderRadius: 50,
    justifyContent: "center",
    alignItems: "center",
  },
  buttonText: {
    color: "white",
    fontSize: 16,
  },
  statusText: {
    marginBottom: 20,
    fontSize: 16,
  },
});

export default Main;
