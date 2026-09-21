// Versioned public question contract. Values, rather than display copy, are sent to the API.
export const QUIZ_VERSION = 'apprentice-v1';
export const QUESTIONS = {
  ageRange: { label: 'How old are you?', options: [['under_18', 'Under 18'], ['18_29', '18–29'], ['30_39', '30–39'], ['40_49', '40–49'], ['50_64', '50–64'], ['65_plus', '65 or over']] },
  goals: { label: 'What would you like help with?', multiple: true, options: [['understand_markets', 'Understanding what I’m looking at, beyond following signals'], ['build_system', 'Building a complete trading process'], ['market_drivers', 'Understanding why the market moves'], ['confidence', 'Feeling more confident in my decisions'], ['full_education', 'All of the above — a full education'], ['exploring', 'I’m exploring my options']] },
  weeklyTime: { label: 'How much time can you realistically commit to learning each week?', options: [['3_5_hours', '3–5 hours'], ['5_10_hours', '5–10 hours'], ['10_plus_hours', 'More than 10 hours'], ['not_sure', 'I’m not sure I can commit time yet']] },
  educationBudget: { label: 'If the program is a good fit, what education investment range would work for you?', options: [['1500_3500', '$1,500–$3,500'], ['3500_5500', '$3,500–$5,500'], ['5500_plus', 'More than $5,500'], ['not_ready', 'I’m not ready to invest financially in my education']] },
  attendance: { label: 'Would you be able to attend a call at the time you choose?', options: [['yes', 'Yes, I plan to attend'], ['unsure', 'I’m not sure about my availability yet']] },
};
