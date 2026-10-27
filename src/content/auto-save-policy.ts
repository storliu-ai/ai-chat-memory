export function canAutomaticallyCaptureConversation(
  pinnedOnly: boolean,
  hasPinnedEvidence: boolean,
  alreadySaved: boolean,
): boolean {
  return !pinnedOnly || hasPinnedEvidence || alreadySaved
}
