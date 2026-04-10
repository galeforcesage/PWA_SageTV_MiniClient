/**
 * SageTV MiniClient Protocol Constants
 * Ported from core/src/main/java/sagex/miniclient/
 *
 * All constants match the Java source exactly.
 */

// ── Connection ──────────────────────────────────────────────
export const PROTOCOL_VERSION = 0x01;
export const SERVER_ACCEPTED = 0x02;
export const DEFAULT_PORT = 31099;
export const MEDIA_PORT = 7818;

/** Connection types for the 7-byte handshake header */
export const ConnectionType = {
  GFX: 0,
  MEDIA: 1,
  GFX_RECONNECT: 5,
};

// ── Server → Client message types ──────────────────────────
export const ServerMsgType = {
  GET_PROPERTY: 0,
  SET_PROPERTY: 1,
  FS_CMD: 2,
  DRAWING_CMD: 16,
};

// ── Client → Server event types ────────────────────────────
export const EventType = {
  IR_EVENT: 128,
  KB_EVENT: 129,
  MOUSE_PRESSED: 130,
  MOUSE_RELEASED: 131,
  MOUSE_CLICKED: 132,
  MOUSE_MOVED: 133,
  MOUSE_DRAGGED: 134,
  MOUSE_WHEEL: 135,
  SAGECOMMAND: 136,
  UI_RESIZE: 192,
  UI_REPAINT: 193,
};

// ── GFX Command opcodes (GFXCMD2.java) ────────────────────
export const GFXCMD = {
  INIT: 1,
  DEINIT: 2,
  DRAWRECT: 16,
  FILLRECT: 17,
  CLEARRECT: 18,
  DRAWOVAL: 19,
  FILLOVAL: 20,
  DRAWROUNDRECT: 21,
  FILLROUNDRECT: 22,
  DRAWTEXT: 23,
  DRAWTEXTURED: 24,
  DRAWLINE: 25,
  LOADIMAGE: 26,
  UNLOADIMAGE: 27,
  LOADFONT: 28,
  UNLOADFONT: 29,
  FLIPBUFFER: 30,
  STARTFRAME: 31,
  LOADIMAGELINE: 32,
  PREPIMAGE: 33,
  LOADIMAGECOMPRESSED: 34,
  XFMIMAGE: 35,
  LOADFONTSTREAM: 36,
  CREATESURFACE: 37,
  SETTARGETSURFACE: 38,
  DRAWTEXTUREDDIFFUSE: 40,
  PUSHTRANSFORM: 41,
  POPTRANSFORM: 42,
  TEXTUREBATCH: 43,
  LOADCACHEDIMAGE: 44,
  LOADIMAGETARGETED: 45,
  PREPIMAGETARGETED: 46,
  SETVIDEOPROP: 130,
};

/** Expected byte lengths (excluding 4-byte header) for each GFX command */
export const GFXCMD_LENGTHS = {
  [GFXCMD.DRAWRECT]: 36,
  [GFXCMD.FILLRECT]: 32,
  [GFXCMD.CLEARRECT]: 32,
  [GFXCMD.DRAWOVAL]: 52,
  [GFXCMD.FILLOVAL]: 48,
  [GFXCMD.DRAWROUNDRECT]: 56,
  [GFXCMD.FILLROUNDRECT]: 52,
  [GFXCMD.DRAWTEXTURED]: 40,
  [GFXCMD.DRAWLINE]: 24,
  [GFXCMD.LOADIMAGE]: 8,
  [GFXCMD.UNLOADIMAGE]: 4,
  [GFXCMD.FLIPBUFFER]: 0,
  [GFXCMD.STARTFRAME]: 0,
  [GFXCMD.CREATESURFACE]: 8,
  [GFXCMD.SETTARGETSURFACE]: 4,
  [GFXCMD.XFMIMAGE]: 20,
  [GFXCMD.SETVIDEOPROP]: 40,
};

/** Human-readable names for debug logging */
export const GFXCMD_NAMES = {
  [GFXCMD.INIT]: 'INIT',
  [GFXCMD.DEINIT]: 'DEINIT',
  [GFXCMD.DRAWRECT]: 'DRAWRECT',
  [GFXCMD.FILLRECT]: 'FILLRECT',
  [GFXCMD.CLEARRECT]: 'CLEARRECT',
  [GFXCMD.DRAWOVAL]: 'DRAWOVAL',
  [GFXCMD.FILLOVAL]: 'FILLOVAL',
  [GFXCMD.DRAWROUNDRECT]: 'DRAWROUNDRECT',
  [GFXCMD.FILLROUNDRECT]: 'FILLROUNDRECT',
  [GFXCMD.DRAWTEXT]: 'DRAWTEXT',
  [GFXCMD.DRAWTEXTURED]: 'DRAWTEXTURED',
  [GFXCMD.DRAWLINE]: 'DRAWLINE',
  [GFXCMD.LOADIMAGE]: 'LOADIMAGE',
  [GFXCMD.UNLOADIMAGE]: 'UNLOADIMAGE',
  [GFXCMD.LOADFONT]: 'LOADFONT',
  [GFXCMD.UNLOADFONT]: 'UNLOADFONT',
  [GFXCMD.FLIPBUFFER]: 'FLIPBUFFER',
  [GFXCMD.STARTFRAME]: 'STARTFRAME',
  [GFXCMD.LOADIMAGELINE]: 'LOADIMAGELINE',
  [GFXCMD.PREPIMAGE]: 'PREPIMAGE',
  [GFXCMD.LOADIMAGECOMPRESSED]: 'LOADIMAGECOMPRESSED',
  [GFXCMD.XFMIMAGE]: 'XFMIMAGE',
  [GFXCMD.LOADFONTSTREAM]: 'LOADFONTSTREAM',
  [GFXCMD.CREATESURFACE]: 'CREATESURFACE',
  [GFXCMD.SETTARGETSURFACE]: 'SETTARGETSURFACE',
  [GFXCMD.DRAWTEXTUREDDIFFUSE]: 'DRAWTEXTUREDDIFFUSE',
  [GFXCMD.PUSHTRANSFORM]: 'PUSHTRANSFORM',
  [GFXCMD.POPTRANSFORM]: 'POPTRANSFORM',
  [GFXCMD.TEXTUREBATCH]: 'TEXTUREBATCH',
  [GFXCMD.LOADCACHEDIMAGE]: 'LOADCACHEDIMAGE',
  [GFXCMD.LOADIMAGETARGETED]: 'LOADIMAGETARGETED',
  [GFXCMD.PREPIMAGETARGETED]: 'PREPIMAGETARGETED',
  [GFXCMD.SETVIDEOPROP]: 'SETVIDEOPROP',
};

// ── Media Command opcodes (MediaCmd.java) ──────────────────
export const MEDIACMD = {
  INIT: 0,
  OPENURL: 16,
  GETMEDIATIME: 17,
  SETMUTE: 18,
  STOP: 19,
  PAUSE: 20,
  PLAY: 21,
  FLUSH: 22,
  PUSHBUFFER: 23,
  GETVIDEORECT: 24,
  SETVIDEORECT: 25,
  GETVOLUME: 26,
  SETVOLUME: 27,
  FRAMESTEP: 28,
  SEEK: 29,
  DVD_STREAMS: 36,
};

// ── Media Player states ────────────────────────────────────
export const PlayerState = {
  NO_STATE: 0,
  LOADED: 1,
  PLAY: 2,
  PAUSE: 3,
  STOPPED: 4,
  EOS: 5,
};

// ── SageCommand enum (SageCommand.java) ────────────────────
// Each entry: [id, key, displayName, irCode]
export const SageCommand = {
  FORCE_QUIT:      { id: -5,  key: 'FORCE_QUIT',      name: 'Force Quit',           ir: -1 },
  KEYBOARD_OSD:    { id: -4,  key: 'KEYBOARD_OSD',    name: 'Show Keyboard',         ir: -1 },
  NAV_OSD:         { id: -3,  key: 'NAV_OSD',         name: 'Show OSD Navigation',   ir: -1 },
  NONE:            { id: -2,  key: 'NONE',            name: 'None',                  ir: -1 },
  UNKNOWN:         { id: -1,  key: '?',               name: 'Unknown',               ir: -1 },
  RAW_KEYBOARD:    { id: 0,   key: 'RAW_KEYBOARD',    name: 'Raw Keyboard',          ir: -1 },
  RAW_IR:          { id: 1,   key: 'RAW_IR',          name: 'Raw IR',                ir: -1 },
  LEFT:            { id: 2,   key: 'left',            name: 'Left',                  ir: -8616 },
  RIGHT:           { id: 3,   key: 'right',           name: 'Right',                 ir: -8612 },
  UP:              { id: 4,   key: 'up',              name: 'Up',                    ir: -8624 },
  DOWN:            { id: 5,   key: 'down',            name: 'Down',                  ir: -8620 },
  PAUSE:           { id: 6,   key: 'pause',           name: 'Pause',                 ir: -8512 },
  PLAY:            { id: 7,   key: 'play',            name: 'Play',                  ir: -8492 },
  FF:              { id: 8,   key: 'ff',              name: 'Skip Fwd/Page Right',   ir: -8496 },
  REW:             { id: 9,   key: 'rew',             name: 'Skip Bkwd/Page Left',   ir: -8504 },
  CHANNEL_UP:      { id: 11,  key: 'ch_up',           name: 'Channel Up/Page Up',    ir: -8576 },
  CHANNEL_DOWN:    { id: 12,  key: 'ch_down',         name: 'Channel Down/Page Down', ir: -8572 },
  VOLUME_UP:       { id: 13,  key: 'vol_up',          name: 'Volume Up',             ir: -8640 },
  VOLUME_DOWN:     { id: 14,  key: 'vol_down',        name: 'Volume Down',           ir: -8636 },
  TV:              { id: 15,  key: 'tv',              name: 'TV',                    ir: -8592 },
  FASTER:          { id: 16,  key: 'faster',          name: 'Play Faster',           ir: -1 },
  SLOWER:          { id: 17,  key: 'slower',          name: 'Play Slower',           ir: -1 },
  GUIDE:           { id: 18,  key: 'guide',           name: 'Guide',                 ir: -8596 },
  POWER:           { id: 19,  key: 'power',           name: 'Power',                 ir: -8460 },
  SELECT:          { id: 20,  key: 'select',          name: 'Select',                ir: -8556 },
  WATCHED:         { id: 21,  key: 'watched',         name: 'Watched',               ir: -8540 },
  RATE_UP:         { id: 22,  key: 'like',            name: 'Favorite',              ir: -8520 },
  RATE_DOWN:       { id: 23,  key: 'dont_like',       name: "Don't Like",            ir: -8660 },
  INFO:            { id: 24,  key: 'info',            name: 'Info',                  ir: -8652 },
  RECORD:          { id: 25,  key: 'record',          name: 'Record',                ir: -8484 },
  MUTE:            { id: 26,  key: 'mute',            name: 'Mute',                  ir: -8644 },
  FULL_SCREEN:     { id: 27,  key: 'full_screen',     name: 'Full Screen',           ir: -1 },
  HOME:            { id: 28,  key: 'home',            name: 'Home',                  ir: -8468 },
  OPTIONS:         { id: 29,  key: 'options',         name: 'Options',               ir: -8480 },
  NUM0:            { id: 30,  key: '0',               name: 'Num 0',                 ir: -8704 },
  NUM1:            { id: 31,  key: '1',               name: 'Num 1',                 ir: -8700 },
  NUM2:            { id: 32,  key: '2',               name: 'Num 2',                 ir: -8696 },
  NUM3:            { id: 33,  key: '3',               name: 'Num 3',                 ir: -8692 },
  NUM4:            { id: 34,  key: '4',               name: 'Num 4',                 ir: -8688 },
  NUM5:            { id: 35,  key: '5',               name: 'Num 5',                 ir: -8684 },
  NUM6:            { id: 36,  key: '6',               name: 'Num 6',                 ir: -8680 },
  NUM7:            { id: 37,  key: '7',               name: 'Num 7',                 ir: -8676 },
  NUM8:            { id: 38,  key: '8',               name: 'Num 8',                 ir: -8672 },
  NUM9:            { id: 39,  key: '9',               name: 'Num 9',                 ir: -8668 },
  SEARCH:          { id: 40,  key: 'search',          name: 'Search',                ir: -1 },
  SETUP:           { id: 41,  key: 'setup',           name: 'Setup',                 ir: -1 },
  LIBRARY:         { id: 42,  key: 'library',         name: 'Library',               ir: -1 },
  POWER_ON:        { id: 43,  key: 'power_on',        name: 'Power On',              ir: -1 },
  POWER_OFF:       { id: 44,  key: 'power_off',       name: 'Power Off',             ir: -1 },
  MUTE_ON:         { id: 45,  key: 'mute_on',         name: 'Mute On',               ir: -1 },
  MUTE_OFF:        { id: 46,  key: 'mute_off',        name: 'Mute Off',              ir: -1 },
  AR_FILL:         { id: 47,  key: 'ar_fill',         name: 'Aspect Ratio Fill',     ir: -1 },
  AR_4X3:          { id: 48,  key: 'ar_4x3',          name: 'Aspect Ratio 4x3',      ir: -1 },
  AR_16X9:         { id: 49,  key: 'ar_16x9',         name: 'Aspect Ratio 16x9',     ir: -1 },
  AR_SOURCE:       { id: 50,  key: 'ar_source',       name: 'Aspect Ratio Source',   ir: -1 },
  VOLUME_UP2:      { id: 51,  key: 'vol_up2',         name: 'Right/Volume Up',       ir: -1 },
  VOLUME_DOWN2:    { id: 52,  key: 'vol_down2',       name: 'Left/Volume Down',      ir: -1 },
  CHANNEL_UP2:     { id: 53,  key: 'ch_up2',          name: 'Up/Channel Up',         ir: -1 },
  CHANNEL_DOWN2:   { id: 54,  key: 'ch_down2',        name: 'Down/Channel Down',     ir: -1 },
  PAGE_UP:         { id: 55,  key: 'page_up',         name: 'Page Up',               ir: -1 },
  PAGE_DOWN:       { id: 56,  key: 'page_down',       name: 'Page Down',             ir: -1 },
  PAGE_RIGHT:      { id: 57,  key: 'page_right',      name: 'Page Right',            ir: -1 },
  PAGE_LEFT:       { id: 58,  key: 'page_left',       name: 'Page Left',             ir: -1 },
  PLAY_PAUSE:      { id: 59,  key: 'play_pause',      name: 'Play/Pause',            ir: -1 },
  PREV_CHANNEL:    { id: 60,  key: 'prev_channel',    name: 'Previous Channel',      ir: -8632 },
  FF_2:            { id: 61,  key: 'ff_2',            name: 'Skip Fwd #2',           ir: -8584 },
  REW_2:           { id: 62,  key: 'rew_2',           name: 'Skip Bkwd #2',          ir: -8560 },
  LIVE_TV:         { id: 63,  key: 'live_tv',         name: 'Live TV',               ir: -1 },
  DVD_REVERSE_PLAY:{ id: 64,  key: 'dvd_reverse',     name: 'DVD Reverse Play',      ir: -1 },
  DVD_CHAPTER_NEXT:{ id: 65,  key: 'dvd_chapter_up',  name: 'DVD Next Chapter',      ir: -1 },
  DVD_CHAPTER_PREV:{ id: 66,  key: 'dvd_chapter_down',name: 'DVD Prev Chapter',      ir: -1 },
  DVD_MENU:        { id: 67,  key: 'dvd_menu',        name: 'DVD Menu',              ir: -1 },
  DVD_TITLE_MENU:  { id: 68,  key: 'dvd_title_menu',  name: 'DVD Title Menu',        ir: -1 },
  DVD_RETURN:      { id: 69,  key: 'dvd_return',      name: 'DVD Return',            ir: -1 },
  DVD_SUBTITLE_CHANGE:  { id: 70, key: 'dvd_subtitle_change',  name: 'DVD Subtitle Change', ir: -1 },
  DVD_SUBTITLE_TOGGLE:  { id: 71, key: 'dvd_subtitle_toggle',  name: 'DVD Subtitle Toggle', ir: -1 },
  DVD_AUDIO_CHANGE:     { id: 72, key: 'dvd_audio_change',     name: 'DVD Audio Change',    ir: -1 },
  DVD_ANGLE_CHANGE:     { id: 73, key: 'dvd_angle_change',     name: 'DVD Angle Change',    ir: -1 },
  DVD:             { id: 74,  key: 'dvd',             name: 'DVD',                   ir: -1 },
  BACK:            { id: 75,  key: 'back',            name: 'Back',                  ir: -8580 },
  FORWARD:         { id: 76,  key: 'forward',         name: 'Forward',               ir: -1 },
  CUSTOMIZE:       { id: 77,  key: 'customize',       name: 'Customize',             ir: -1 },
  CUSTOM1:         { id: 78,  key: 'custom1',         name: 'Custom1',               ir: -1 },
  CUSTOM2:         { id: 79,  key: 'custom2',         name: 'Custom2',               ir: -1 },
  CUSTOM3:         { id: 80,  key: 'custom3',         name: 'Custom3',               ir: -1 },
  CUSTOM4:         { id: 81,  key: 'custom4',         name: 'Custom4',               ir: -1 },
  CUSTOM5:         { id: 82,  key: 'custom5',         name: 'Custom5',               ir: -1 },
  DELETE:          { id: 83,  key: 'delete',           name: 'Delete',                ir: -1 },
  MUSIC:           { id: 84,  key: 'music',           name: 'Music Jukebox',         ir: -8604 },
  SCHEDULE:        { id: 85,  key: 'schedule',        name: 'Recording Schedule',    ir: -1 },
  RECORDINGS:      { id: 86,  key: 'recordings',      name: 'SageTV Recordings',     ir: -8608 },
  PICTURE_LIBRARY: { id: 87,  key: 'picture_library', name: 'Picture Library',       ir: -8600 },
  VIDEO_LIBRARY:   { id: 88,  key: 'video_library',   name: 'Video Library',         ir: -1 },
  STOP:            { id: 89,  key: 'stop',            name: 'Stop',                  ir: -8488 },
  EJECT:           { id: 90,  key: 'eject',           name: 'Eject',                 ir: -1 },
  STOP_EJECT:      { id: 91,  key: 'stop_eject',      name: 'Stop/Eject',            ir: -1 },
  INPUT:           { id: 92,  key: 'input',           name: 'Input',                 ir: -1 },
  SMOOTH_FF:       { id: 93,  key: 'smooth_ff',       name: 'Smooth Fast Forward',   ir: -1 },
  SMOOTH_REW:      { id: 94,  key: 'smooth_rew',      name: 'Smooth Rewind',         ir: -1 },
  DASH:            { id: 95,  key: 'dash',            name: '-',                     ir: -1 },
  AR_TOGGLE:       { id: 96,  key: 'ar_toggle',       name: 'Aspect Ratio Toggle',   ir: -1 },
  FULL_SCREEN_ON:  { id: 97,  key: 'full_screen_on',  name: 'Full Screen On',        ir: -1 },
  FULL_SCREEN_OFF: { id: 98,  key: 'full_screen_off', name: 'Full Screen Off',       ir: -1 },
  RIGHT_FF:        { id: 99,  key: 'right_ff',        name: 'Right/Skip Fwd',        ir: -1 },
  LEFT_REW:        { id: 100, key: 'right_rew',       name: 'Left/Skip Bkwd',        ir: -1 },
  UP_VOL_UP:       { id: 101, key: 'up_vol_up',       name: 'Up/Volume Up',          ir: -1 },
  DOWN_VOL_DOWN:   { id: 102, key: 'down_vol_down',   name: 'Down/Volume Down',      ir: -1 },
  ONLINE:          { id: 103, key: 'online',          name: 'Online',                ir: -1 },
  VIDEO_OUTPUT:    { id: 104, key: 'video_output',    name: 'Video Output',          ir: -1 },
  SCROLL_LEFT:     { id: 105, key: 'scroll_left',     name: 'Scroll Left',           ir: -1 },
  SCROLL_RIGHT:    { id: 106, key: 'scroll_right',    name: 'Scroll Right',          ir: -1 },
  SCROLL_UP:       { id: 107, key: 'scroll_up',       name: 'Scroll Up',             ir: -1 },
  SCROLL_DOWN:     { id: 108, key: 'scroll_down',     name: 'Scroll Down',           ir: -1 },
  ANYTHING:        { id: 109, key: 'anything',        name: 'Anything',              ir: -1 },
};

/** Lookup SageCommand by numeric id */
export const SageCommandById = {};
for (const [, cmd] of Object.entries(SageCommand)) {
  SageCommandById[cmd.id] = cmd;
}

// ── File System Commands ───────────────────────────────────
export const FSCMD = {
  CREATE_DIRECTORY: 64,
  GET_PATH_ATTRIBUTES: 65,
  GET_FILE_SIZE: 66,
  GET_PATH_MODIFIED_TIME: 67,
  DIR_LIST: 68,
  LIST_ROOTS: 69,
  DOWNLOAD_FILE: 70,
  UPLOAD_FILE: 71,
  DELETE_FILE: 72,
};

export const FSResult = {
  SUCCESS: 0,
  PATH_EXISTS: 1,
  NO_PERMISSIONS: 2,
  PATH_DOES_NOT_EXIST: 3,
  NO_SPACE: 4,
  ERROR_UNKNOWN: 5,
};

export const FSPathAttr = {
  HIDDEN: 0x01,
  DIRECTORY: 0x02,
  FILE: 0x04,
};

// ── Client capability properties ───────────────────────────
export const ClientProperty = {
  GFX_BLENDMODE: 'PREMULTIPLY',
  GFX_COMPOSITE: 'BLEND',
  GFX_SURFACES: 'TRUE',
  GFX_COLORKEY: '080010',
  GFX_TEXTMODE: '',      // empty = no text mode, matching Java MiniClient
  GFX_SCALING: 'hardware',
  GFX_OFFLINE_IMAGE_CACHE: 'TRUE',
  ADVANCED_IMAGE_CACHING: 'TRUE',
  GFX_DRAWMODE: 'FULLSCREEN',
  GFX_HIRES_SURFACES: 'TRUE',
  GFX_VIDEO_MASKS: '31',
  GFX_SUPPORTED_ASPECTS: '16:9',
  INPUT_DEVICES: 'IR,KEYBOARD',
  STREAMING_PROTOCOLS: 'file,stv',
  PUSH_AV_CONTAINERS: 'MPEG2-TS',
  PULL_AV_CONTAINERS: '',
  VIDEO_CODECS: 'H.264',
  AUDIO_CODECS: 'AAC',
};

// ── Crypto algorithms ──────────────────────────────────────
export const CryptoAlgorithm = {
  RSA: 'RSA',
  DH: 'DH',
  BLOWFISH: 'Blowfish',
  DES: 'DES',
};

// ── Misc ───────────────────────────────────────────────────
export const MEDIA_PLAYER_BUFFER_DELAY = 0;
export const DESIRED_VIDEO_PREBUFFER = 16 * 1024 * 1024;
export const DESIRED_AUDIO_PREBUFFER = 2 * 1024 * 1024;
export const DISABLE_TRACK = 8192;
