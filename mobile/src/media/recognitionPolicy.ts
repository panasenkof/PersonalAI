/** Protected notes and protected collections cannot send stored originals to an external model. */
export function maySendOriginalToProvider(noteSensitivity: string | undefined, collectionSensitivity: string | undefined): boolean {
  return noteSensitivity === "standard" && collectionSensitivity === "standard";
}
