import React from 'react';
import { Box, Text } from '../../../vendor/ink/src/index.js';

export interface Attachment {
  path?: string;  //  FIX: Make path optional to match AttachedImage
  name?: string;
  type?: string;
  mediaType?: string; //  NEW: MIME type (e.g., 'image/png')
  data?: string; //  NEW: base64 encoded image data
}

export interface AttachmentBarProps {
  attachments: Attachment[];
  onRemove?: (index: number) => void;
}

export const AttachmentBar: React.FC<AttachmentBarProps> = ({
  attachments,
  onRemove
}) => {
  if (attachments.length === 0) {
    return null;
  }

  return (
    <Box flexDirection="column" paddingLeft={2} marginBottom={1}>
      <Text color="magenta" dimColor>Attachments:</Text>
      {attachments.map((attachment, index) => {
        const name = attachment.name || attachment.path?.split('/').pop() || 'unknown';

        return (
          <Box key={index}>
            <Text color="magenta">
              {name}
            </Text>
            {onRemove && (
              <Text color="gray" dimColor> (press ⌫ Backspace to remove)</Text>
            )}
          </Box>
        );
      })}
    </Box>
  );
};
