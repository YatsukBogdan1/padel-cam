export function newRecordingId(): string {
  return crypto.randomUUID();
}

export function objectKey(recordingId: string): string {
  return `recordings/${recordingId}.mp4`;
}

export function thumbnailKey(recordingId: string): string {
  return `thumbnails/${recordingId}.jpg`;
}
