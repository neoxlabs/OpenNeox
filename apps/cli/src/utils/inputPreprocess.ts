type InputImage = {
  path?: string;
  name?: string;
};

interface PreprocessUserInputResult {
  userInput: string;
  ignore: boolean;
}

export function preprocessUserInput(
  rawInput: string,
  images?: InputImage[],
): PreprocessUserInputResult {
  let userInput = rawInput ? rawInput.trim() : '';
  userInput = userInput.replace(/\[image:[^\]]+\]/g, '').trim();

  if (!userInput && images && images.length > 0) {
    userInput = '请分析这张图片';
  }

  return {
    userInput,
    ignore: !userInput && (!images || images.length === 0),
  };
}

export function buildImagesToDisplay(images?: InputImage[]): Array<{
  data: string;
  mediaType: string;
  path?: string;
  name?: string;
}> | undefined {
  return images?.map((image) => ({
    data: '',
    mediaType: 'image/png',
    path: image.path,
    name: image.name,
  }));
}
