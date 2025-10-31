// Function to parse inline markdown formatting (bold, italic, code)
const parseInlineFormatting = (text) => {
  const parts = [];
  let currentIndex = 0;
  
  // Regex to match **bold**, *italic*, or `code`
  const regex = /(\*\*(.+?)\*\*)|(\*(.+?)\*)|(`(.+?)`)/g;
  let match;
  
  while ((match = regex.exec(text)) !== null) {
    // Add text before the match
    if (match.index > currentIndex) {
      parts.push(text.slice(currentIndex, match.index));
    }
    
    // Add formatted text
    if (match[1]) {
      // Bold text (**text**)
      parts.push(<strong key={match.index}>{match[2]}</strong>);
    } else if (match[3]) {
      // Italic text (*text*)
      parts.push(<em key={match.index}>{match[4]}</em>);
    } else if (match[5]) {
      // Code text (`text`)
      parts.push(<code key={match.index}>{match[6]}</code>);
    }
    
    currentIndex = regex.lastIndex;
  }
  
  // Add remaining text
  if (currentIndex < text.length) {
    parts.push(text.slice(currentIndex));
  }
  
  return parts.length > 0 ? parts : text;
};

// Function to format agent messages with proper structure
export const formatAgentMessage = (text) => {
  if (!text) return text;
  
  // Split by double newlines to create paragraphs
  const paragraphs = text.split('\n\n').filter(p => p.trim());
  
  return paragraphs.map((paragraph, index) => {
    const lines = paragraph.split('\n').map(line => line.trimEnd());
    
    // Check for nested bullet structure (main bullets with indented sub-bullets)
    const hasNestedBullets = lines.some(line => 
      line.match(/^\s{4,}\*\s/) // Lines with 4+ spaces before *
    );
    
    if (hasNestedBullets) {
      const items = [];
      let currentItem = null;
      
      lines.forEach(line => {
        const trimmedLine = line.trim();
        if (!trimmedLine) return;
        
        // Main bullet (no leading spaces or minimal spaces)
        if (line.match(/^\s{0,2}\*\s/)) {
          if (currentItem) items.push(currentItem);
          currentItem = {
            main: trimmedLine.replace(/^\*\s*/, ''),
            subItems: []
          };
        }
        // Sub-bullet (4+ leading spaces)
        else if (line.match(/^\s{4,}\*\s/) && currentItem) {
          currentItem.subItems.push(trimmedLine.replace(/^\*\s*/, ''));
        }
      });
      
      if (currentItem) items.push(currentItem);
      
      return (
        <ul key={index}>
          {items.map((item, i) => (
            <li key={i}>
              {parseInlineFormatting(item.main)}
              {item.subItems.length > 0 && (
                <ul style={{ marginTop: '0.5rem' }}>
                  {item.subItems.map((subItem, j) => (
                    <li key={j}>{parseInlineFormatting(subItem)}</li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      );
    }
    
    // Check if it's a mixed format with heading followed by bullet points
    // Pattern: **Title** followed by lines starting with * **Label:**
    const hasHeading = lines[0] && lines[0].trim().match(/^\*\*.*\*\*$/);
    const hasBulletDetails = lines.slice(1).some(line => 
      line.trim().match(/^\*\s+\*\*.*\*\*:/)
    );
    
    if (hasHeading && hasBulletDetails) {
      return (
        <div key={index}>
          <p style={{ marginBottom: '0.5rem' }}>
            {parseInlineFormatting(lines[0].trim())}
          </p>
          <ul>
            {lines.slice(1).filter(line => line.trim()).map((line, i) => {
              const cleanedLine = line.replace(/^\*\s+/, '').trim();
              return <li key={i}>{parseInlineFormatting(cleanedLine)}</li>;
            })}
          </ul>
        </div>
      );
    }
    
    // Check if paragraph is a bullet list (lines starting with -, *, or •)
    const isBulletList = lines.every(line => 
      line.trim().match(/^[-*•]\s/) || line.trim() === ''
    );
    
    // Check if paragraph is a numbered list
    const isNumberedList = lines.every(line => 
      line.trim().match(/^\d+\.\s/) || line.trim() === ''
    );
    
    if (isBulletList) {
      const items = lines
        .filter(line => line.trim())
        .map(line => line.replace(/^[-*•]\s*/, '').trim());
      return (
        <ul key={index}>
          {items.map((item, i) => (
            <li key={i}>{parseInlineFormatting(item)}</li>
          ))}
        </ul>
      );
    }
    
    if (isNumberedList) {
      const items = lines
        .filter(line => line.trim())
        .map(line => line.replace(/^\d+\.\s*/, '').trim());
      return (
        <ol key={index}>
          {items.map((item, i) => (
            <li key={i}>{parseInlineFormatting(item)}</li>
          ))}
        </ol>
      );
    }
    
    // Regular paragraph - check for single newlines within it
    if (paragraph.includes('\n')) {
      // Preserve single line breaks within paragraphs
      return (
        <p key={index}>
          {paragraph.split('\n').map((line, i, arr) => (
            <div key={i}>
              {parseInlineFormatting(line)}
              {i < arr.length - 1 && <br />}
            </div>
          ))}
        </p>
      );
    }
    
    return <p key={index}>{parseInlineFormatting(paragraph)}</p>;
  });
};