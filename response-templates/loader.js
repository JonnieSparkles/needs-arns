import fs from 'fs';
import path from 'path';

// Template cache
const templateCache = new Map();

/**
 * Load a template from JSON file
 * @param {string} templateType - The template type (e.g., 'success-post-archive')
 * @returns {Object|null} Template object or null if not found
 */
export function loadTemplate(templateType) {
  // Check cache first
  if (templateCache.has(templateType)) {
    return templateCache.get(templateType);
  }

  try {
    const templatePath = path.join(process.cwd(), 'response-templates', `${templateType}.json`);
    if (!fs.existsSync(templatePath)) {
      console.warn(`Template not found: ${templateType}`);
      return null;
    }

    const templateData = fs.readFileSync(templatePath, 'utf8');
    const template = JSON.parse(templateData);
    
    // Validate template structure
    if (!template.template || !Array.isArray(template.template)) {
      console.error(`Invalid template structure: ${templateType}`);
      return null;
    }

    // Cache the template
    templateCache.set(templateType, template);
    return template;
  } catch (error) {
    console.error(`Error loading template ${templateType}:`, error.message);
    return null;
  }
}

/**
 * Render a template with variables
 * @param {string} templateType - The template type
 * @param {Object} variables - Variables to substitute
 * @returns {string|null} Rendered message or null if template not found
 */
export function renderTemplate(templateType, variables = {}) {
  const template = loadTemplate(templateType);
  if (!template) {
    return null;
  }

  try {
    // Render each line with variable substitution
    const renderedLines = template.template.map(line => {
      const originalLine = line;
      const rendered = line.replace(/\{(\w+)\}/g, (match, varName) => {
        return variables[varName] !== undefined ? variables[varName] : match; // Keep original if variable not found
      });
      // Remove lines that are ONLY a variable placeholder that became empty
      // But keep intentional empty lines (empty strings) and lines with other content
      if (originalLine.trim().match(/^\{\w+\}$/) && rendered.trim() === '') {
        return null; // Mark for removal
      }
      return rendered;
    }).filter(line => line !== null); // Remove null lines

    const message = renderedLines.join('\n');
    
    // Check length and try fallback if needed
    if (template.maxLength && message.length > template.maxLength) {
      if (template.fallback) {
        console.log(`⚠️ Message too long (${message.length} chars), trying fallback: ${template.fallback}`);
        return renderTemplate(template.fallback, variables);
      } else {
        console.warn(`⚠️ Message too long (${message.length} chars) and no fallback available`);
      }
    }

    return message;
  } catch (error) {
    console.error(`Error rendering template ${templateType}:`, error.message);
    return null;
  }
}

/**
 * Get all available template types
 * @returns {string[]} Array of template types
 */
export function getAvailableTemplates() {
  try {
    const templatesDir = path.join(process.cwd(), 'response-templates');
    if (!fs.existsSync(templatesDir)) {
      return [];
    }

    return fs.readdirSync(templatesDir)
      .filter(file => file.endsWith('.json') && file !== 'loader.js')
      .map(file => file.replace('.json', ''));
  } catch (error) {
    console.error('Error getting available templates:', error.message);
    return [];
  }
}

/**
 * Clear template cache (useful for development)
 */
export function clearTemplateCache() {
  templateCache.clear();
}
