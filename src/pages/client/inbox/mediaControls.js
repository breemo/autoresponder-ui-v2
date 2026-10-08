import { PhotoIcon, DocumentIcon, MicrophoneIcon } from "@heroicons/react/24/outline";
import { MESSAGE_TYPES } from "../../../lib/mediaMessages.js";

// Media controls — WhatsApp Media & Attachment Support v1 (moved unchanged
// from ClientMessages.jsx). `type` maps each button to a canonical
// MESSAGE_TYPES value (single source of truth for both the composer and the
// message renderer, which reuses this same array to resolve a media
// message's icon/label). Enabled per conversation by canSendMediaOnChannel()
// — see SUPPORTED_MEDIA_CHANNEL_VALUES in src/lib/mediaMessages.js.
export const MEDIA_CONTROLS = [
  { key: "image", type: MESSAGE_TYPES.IMAGE, labelKey: "messagesPage.mediaImage", icon: PhotoIcon },
  { key: "document", type: MESSAGE_TYPES.DOCUMENT, labelKey: "messagesPage.mediaDocument", icon: DocumentIcon },
  { key: "voice", type: MESSAGE_TYPES.AUDIO, labelKey: "messagesPage.mediaVoice", icon: MicrophoneIcon },
];
