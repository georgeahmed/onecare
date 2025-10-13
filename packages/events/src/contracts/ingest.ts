// AUTO-GENERATED from schemas. DO NOT EDIT.\n

export interface PortalSubmission {
  practiceId: string;
  patient: {
    id: string;
    dob?: string;
    locale?: string;
  };
  narrative: string;
  /**
   * @maxItems 10
   */
  attachments?:
    | []
    | [
        {
          contentType: string;
          url: string;
        }
      ]
    | [
        {
          contentType: string;
          url: string;
        },
        {
          contentType: string;
          url: string;
        }
      ]
    | [
        {
          contentType: string;
          url: string;
        },
        {
          contentType: string;
          url: string;
        },
        {
          contentType: string;
          url: string;
        }
      ]
    | [
        {
          contentType: string;
          url: string;
        },
        {
          contentType: string;
          url: string;
        },
        {
          contentType: string;
          url: string;
        },
        {
          contentType: string;
          url: string;
        }
      ]
    | [
        {
          contentType: string;
          url: string;
        },
        {
          contentType: string;
          url: string;
        },
        {
          contentType: string;
          url: string;
        },
        {
          contentType: string;
          url: string;
        },
        {
          contentType: string;
          url: string;
        }
      ]
    | [
        {
          contentType: string;
          url: string;
        },
        {
          contentType: string;
          url: string;
        },
        {
          contentType: string;
          url: string;
        },
        {
          contentType: string;
          url: string;
        },
        {
          contentType: string;
          url: string;
        },
        {
          contentType: string;
          url: string;
        }
      ]
    | [
        {
          contentType: string;
          url: string;
        },
        {
          contentType: string;
          url: string;
        },
        {
          contentType: string;
          url: string;
        },
        {
          contentType: string;
          url: string;
        },
        {
          contentType: string;
          url: string;
        },
        {
          contentType: string;
          url: string;
        },
        {
          contentType: string;
          url: string;
        }
      ]
    | [
        {
          contentType: string;
          url: string;
        },
        {
          contentType: string;
          url: string;
        },
        {
          contentType: string;
          url: string;
        },
        {
          contentType: string;
          url: string;
        },
        {
          contentType: string;
          url: string;
        },
        {
          contentType: string;
          url: string;
        },
        {
          contentType: string;
          url: string;
        },
        {
          contentType: string;
          url: string;
        }
      ]
    | [
        {
          contentType: string;
          url: string;
        },
        {
          contentType: string;
          url: string;
        },
        {
          contentType: string;
          url: string;
        },
        {
          contentType: string;
          url: string;
        },
        {
          contentType: string;
          url: string;
        },
        {
          contentType: string;
          url: string;
        },
        {
          contentType: string;
          url: string;
        },
        {
          contentType: string;
          url: string;
        },
        {
          contentType: string;
          url: string;
        }
      ]
    | [
        {
          contentType: string;
          url: string;
        },
        {
          contentType: string;
          url: string;
        },
        {
          contentType: string;
          url: string;
        },
        {
          contentType: string;
          url: string;
        },
        {
          contentType: string;
          url: string;
        },
        {
          contentType: string;
          url: string;
        },
        {
          contentType: string;
          url: string;
        },
        {
          contentType: string;
          url: string;
        },
        {
          contentType: string;
          url: string;
        },
        {
          contentType: string;
          url: string;
        }
      ];
  channel: "web" | "ivr";
}
