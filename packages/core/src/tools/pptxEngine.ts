/**
 * The PPTX engine is not part of the open-source build.
 * Tool packs and prompts read this flag so the model is never offered PPT tools that don't exist.
 */
export const HAS_PPTX_ENGINE: boolean = false;
